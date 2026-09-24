#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/sched.h>
#include <linux/tcp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Evaluation deployment boundary, not the cooperative Node permission profile.
// ABI 6 also scopes signals and abstract Unix sockets to the sandbox domain.
struct ruleset { uint64_t fs, net, scoped; };
static void fail(const char *message) { perror(message); exit(126); }
static volatile sig_atomic_t stopping = 0;
static void stop_signal(int signal) { (void)signal; stopping = 1; }
// A trusted subreaper owns even double-forked/setsid descendants. Polling a live host
// from JavaScript cannot observe short-lived parents reliably.
static void reap_tree(void) {
  char name[128];
  snprintf(name, sizeof(name), "/proc/self/task/%d/children", getpid());
  for (int attempt = 0; attempt < 500; attempt++) {
    FILE *children = fopen(name, "r");
    if (!children) { perror("supervisor children"); _exit(126); }
    int pid;
    while (fscanf(children, "%d", &pid) == 1) if (kill(pid, SIGKILL) && errno != ESRCH) { perror("supervisor kill"); _exit(126); }
    fclose(children);
    pid_t waited;
    do { waited = waitpid(-1, NULL, WNOHANG); } while (waited > 0);
    if (waited < 0 && errno == ECHILD) return;
    usleep(10000);
  }
  fprintf(stderr, "supervisor cleanup deadline\n"); _exit(126);
}
static void path_rule(int fd, const char *path, int writable) {
  int target = open(path, O_PATH | O_CLOEXEC);
  struct stat st;
  if (target < 0 || fstat(target, &st)) fail("sandbox path");
  uint64_t rights = writable < 0 ? 0 : LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE;
  if (S_ISDIR(st.st_mode)) rights |= LANDLOCK_ACCESS_FS_READ_DIR;
  if (writable > 0) rights |= LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  if (writable > 0 && S_ISDIR(st.st_mode)) rights |= LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
    LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = target };
  if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail("sandbox rule");
  close(target);
}

// Supervise connect() without CONTINUE: never authorize a syscall with mutable pointer arguments.
// The broker creates a socket connected to the one fixed loopback gateway and replaces the child's FD.
static void broker(int channel, pid_t child, unsigned port, int supervise) {
  char byte, control[CMSG_SPACE(sizeof(int))];
  struct iovec io = { &byte, 1 };
  struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
  if (recvmsg(channel, &message, 0) != 1) {
    if (supervise) reap_tree();
    fail("broker receive");
  }
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (!header || header->cmsg_type != SCM_RIGHTS) fail("broker listener");
  int listener; memcpy(&listener, CMSG_DATA(header), sizeof(listener)); close(channel);
  for (;;) {
    int status;
    if (supervise && stopping) { close(listener); reap_tree(); exit(143); }
    if (waitpid(child, &status, WNOHANG) == child) {
      close(listener);
      if (supervise) reap_tree();
      exit(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
    }
    struct pollfd pending = { .fd = listener, .events = POLLIN };
    if (poll(&pending, 1, 100) <= 0) continue;
    struct seccomp_notif request = {0};
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request)) { if (errno == EINTR || errno == ENOENT) continue; fail("broker notification"); }
    struct seccomp_notif_resp response = { .id = request.id, .error = -EPERM };
    struct sockaddr_in address = {0};
    struct iovec local = { &address, sizeof(address) }, remote = { (void *)(uintptr_t)request.data.args[1], sizeof(address) };
    if (request.data.nr == __NR_connect && request.data.args[2] == sizeof(address) &&
        process_vm_readv(request.pid, &local, 1, &remote, 1, 0) == sizeof(address) &&
        address.sin_family == AF_INET && address.sin_addr.s_addr == htonl(INADDR_LOOPBACK) && address.sin_port == htons(port) &&
        !ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id)) {
      int target = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
      struct sockaddr_in fixed = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
      int connected = target >= 0 ? connect(target, (struct sockaddr *)&fixed, sizeof(fixed)) : -1;
      if (target >= 0 && (connected == 0 || errno == EINPROGRESS)) {
        struct pollfd ready = { .fd = target, .events = POLLOUT };
        int error = 0; socklen_t length = sizeof(error);
        if (poll(&ready, 1, 1000) > 0 && !getsockopt(target, SOL_SOCKET, SO_ERROR, &error, &length) && !error) {
          struct seccomp_notif_addfd add = { .id = request.id, .flags = SECCOMP_ADDFD_FLAG_SETFD, .srcfd = target, .newfd = request.data.args[0], .newfd_flags = O_CLOEXEC };
          if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD, &add) >= 0) response.error = 0;
        }
      }
      if (target >= 0) close(target);
    }
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) && errno != ENOENT) fail("broker response");
  }
}

int main(int argc, char **argv) {
  if (syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < 6) fail("Landlock ABI 6 required");
  struct ruleset rules = { .fs = (1ULL << 15) - 1, .net = 3, .scoped = 3 };
  int fd = syscall(__NR_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (fd < 0) fail("sandbox create");
  int command = 0, tree = 0, supervise = 0;
  unsigned port = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { command = i + 1; break; }
    if (!strcmp(argv[i], "--tree")) { tree = 1; continue; }
    if (!strcmp(argv[i], "--supervise")) { supervise = 1; continue; }
    if (i + 1 >= argc) fail("sandbox argument");
    if (!strcmp(argv[i], "--read")) { path_rule(fd, argv[++i], 0); continue; }
    if (!strcmp(argv[i], "--list")) { path_rule(fd, argv[++i], -1); continue; }
    if (!strcmp(argv[i], "--write")) { path_rule(fd, argv[++i], 1); continue; }
    // The host may connect only to the dedicated gateway port. Candidate scoring grants no port.
    if (!strcmp(argv[i], "--tcp")) {
      struct landlock_net_port_attr rule = { .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP, .port = strtoul(argv[++i], NULL, 10) };
      port = rule.port;
      if (!rule.port || rule.port > 65535 || syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_NET_PORT, &rule, 0)) fail("sandbox port");
      continue;
    }
    errno = EINVAL; fail("unknown sandbox option");
  }
  if (!command || command >= argc) { errno = EINVAL; fail("sandbox command"); }
  if (supervise) {
    if (!port || prctl(PR_SET_CHILD_SUBREAPER, 1)) fail("supervisor setup");
    struct sigaction action = { .sa_handler = stop_signal };
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) ||
        prctl(PR_SET_PDEATHSIG, SIGTERM)) fail("supervisor signals");
  }
  int channel[2] = {-1, -1};
  if (port) {
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, channel)) fail("broker channel");
    pid_t parent = getpid(), child = fork();
    if (child < 0) fail("broker fork");
    if (child) {
      if (supervise && atexit(reap_tree)) fail("supervisor finalizer");
      close(channel[1]); close(fd); broker(channel[0], child, port, supervise);
    }
    close(channel[0]);
    path_rule(fd, "/proc/self/maps", 0);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) fail("broker lifetime");
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(__NR_landlock_restrict_self, fd, 0)) fail("sandbox restrict");
  close(fd);
  // Deny process introspection/namespace escape and UDP/raw sockets; Landlock mediates TCP ports.
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    DENY(ptrace), DENY(process_vm_readv), DENY(process_vm_writev), DENY(pidfd_getfd), DENY(open_by_handle_at),
    DENY(mount), DENY(umount2), DENY(pivot_root), DENY(chroot), DENY(setns), DENY(unshare), DENY(bpf),
    DENY(io_uring_setup), DENY(kexec_load), DENY(init_module), DENY(finit_module), DENY(delete_module),
    // Fast Open can create a TCP connection through send* without calling connect().
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[3])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmmsg, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[3])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setsockopt, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_TCP, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TCP_REPAIR, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TCP_FASTOPEN_CONNECT, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TCP_FASTOPEN, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 15),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail("sandbox seccomp");
  // The candidate executor owns a detached process group. Descendants may not escape it.
  if (tree) {
    struct sock_filter boundary[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      DENY(setsid), DENY(setpgid),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS | CLONE_PARENT, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog group = { .len = sizeof(boundary) / sizeof(boundary[0]), .filter = boundary };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &group)) fail("sandbox process group");
  }
  if (port) {
    struct sock_filter network[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      DENY(seccomp),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 4),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_SECCOMP, 1, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_PDEATHSIG, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog networking = { .len = sizeof(network) / sizeof(network[0]), .filter = network };
    int listener = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &networking);
    if (listener < 0) fail("broker filter");
    char byte = 0, control[CMSG_SPACE(sizeof(listener))];
    struct iovec io = { &byte, 1 };
    struct msghdr message = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof(control) };
    memset(control, 0, sizeof(control));
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(listener));
    memcpy(CMSG_DATA(header), &listener, sizeof(listener));
    if (sendmsg(channel[1], &message, 0) != 1) fail("broker send");
    close(listener); close(channel[1]);
  }
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core)) fail("sandbox rlimit");
  execvp(argv[command], argv + command);
  fail("sandbox exec");
}
