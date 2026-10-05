"""Trusted host control for a task-sized parent cgroup and two isolated leaves.

The task receives no writable cgroup mount, Docker socket or new capability.
Native supervisor and commands stay in the task's filesystem/network namespace.
Their combined CPU/RAM ceiling is the original Harbor declaration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import struct
import subprocess
import threading
import time


def process(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
    return {"pid": pid, "parent": int(fields[1]), "start_ticks": fields[19], "state": fields[0]}


def membership(pid):
    return Path(f"/proc/{pid}/cgroup").read_text().strip().partition("::")[2]


class Broker(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, config):
        self.config = config
        self.lock = threading.Lock()
        self.owner = None
        self.leaf = Path('/cgroup') / config['leaf']
        self.native = Path('/cgroup/native')
        parent = Path('/cgroup')
        if set(p.name for p in parent.iterdir() if p.is_dir()) != {config['leaf']}:
            raise RuntimeError('Unexpected processes/children in the dedicated task slice')
        if (parent/'cgroup.procs').read_text().strip():
            raise RuntimeError('The task parent must have no resident processes')
        reserve = min(1024**3, config['memory']//2)
        self.native.mkdir()
        (parent/'memory.max').write_text(str(config['memory']))
        (parent/'memory.swap.max').write_text('0')
        (parent/'cpu.max').write_text(f"{max(1000, int(config['cpus'] * 100000))} 100000")
        (self.native/'memory.max').write_text(str(reserve))
        (self.native/'memory.swap.max').write_text('0')
        (self.leaf/'memory.max').write_text(str(config['memory']-reserve))
        (self.leaf/'memory.swap.max').write_text('0')
        super().__init__('/channel/process.sock', Handler)
        os.chmod('/channel/process.sock', 0o666)
        Path('/control/resource-ready.json').write_text(json.dumps({
            'parent_memory_bytes':config['memory'], 'supervisor_memory_bytes':reserve,
            'task_and_tools_memory_bytes':config['memory']-reserve,'parent_cpus':config['cpus'],
            'network':'none','task_cgroup_mount':False,'task_privilege_increase':False,
            'supervisor_oom_priority_is_not_the_isolation_boundary':True,
        }, indent=2)+'\n')

    def admit(self, peer, value):
        with self.lock:
            child = process(peer)
            parent = process(child['parent'])
            if value.get('role') == 'supervisor':
                if self.owner is not None or not secrets.compare_digest(value.get('token',''), self.config['token']):
                    raise RuntimeError('Supervisor admission denied')
                if membership(parent['pid']) != self.config['task_cgroup']:
                    raise RuntimeError('Supervisor is outside the admitted task')
                destination = self.native
                self.owner = parent
            elif value.get('role') == 'tool':
                if self.owner is None or process(self.owner['pid'])['start_ticks'] != self.owner['start_ticks']:
                    raise RuntimeError('Supervisor ownership is unavailable')
                ancestor = parent
                while ancestor['pid'] != self.owner['pid'] and ancestor['parent'] > 1:
                    ancestor = process(ancestor['parent'])
                if ancestor['pid'] != self.owner['pid']:
                    raise RuntimeError('Only supervisor descendants may enter the tool cgroup')
                destination = self.leaf
            else:
                raise RuntimeError('Unsupported admission role')
            # The Python client asks for its shell parent, not an arbitrary PID.
            # Both move before that shell is allowed to execute untrusted work.
            (destination/'cgroup.procs').write_text(str(parent['pid']))
            (destination/'cgroup.procs').write_text(str(child['pid']))
            event = {'at':time.time(),'role':value['role'],'process':parent,
                     'memory_max':int((destination/'memory.max').read_text())}
            with Path('/control/resource-admissions.jsonl').open('a') as stream:
                stream.write(json.dumps(event)+'\n')
            return {'admitted':True,'memory_max':event['memory_max']}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        try:
            peer = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
            raw = self.rfile.readline(2049)
            if len(raw)>2048 or not raw.endswith(b'\n'):
                raise ValueError('Invalid request frame')
            result = self.server.admit(peer, json.loads(raw))
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            with Path('/control/resource-denials.jsonl').open('a') as stream:
                stream.write(json.dumps({'at':time.time(),'error':type(error).__name__,'message':str(error)})+'\n')
            result = {'admitted':False,'error':'Process resource admission rejected'}
        self.wfile.write(json.dumps(result).encode()+b'\n')


def start(container, root, image):
    root = Path(root).resolve()
    inspected = json.loads(subprocess.run(['docker','inspect',container],capture_output=True,text=True,check=True,timeout=20).stdout)[0]
    cgroup = membership(inspected['State']['Pid'])
    parent = (Path('/sys/fs/cgroup')/cgroup.lstrip('/')).parent
    if not parent.name.startswith('pcbench') or not parent.name.endswith('.slice'):
        raise RuntimeError('Dedicated cgroup parent was not installed before task startup')
    memory = inspected['HostConfig']['Memory']
    cpus = inspected['HostConfig']['NanoCpus']/1e9
    if memory < 512*1024**2 or cpus <= 0:
        raise RuntimeError('Finite official CPU/RAM declarations are required')
    config = {'memory':memory,'cpus':cpus,'leaf':Path(cgroup).name,'task_cgroup':cgroup,'token':secrets.token_urlsafe(32)}
    path=root/'control/resource-config.json'
    with path.open('x') as stream:
        os.chmod(path,0o600);json.dump(config,stream)
    result=subprocess.run(['docker','run','-d','--user','0:0','--pid','host','--cgroupns','host','--network','none','--read-only',
        '--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true','--memory','128m','--cpus','0.25',
        '--label','procontract.role=resource-broker','--label','procontract.run='+root.name,
        '-v',str(parent)+':/cgroup','-v',str(root/'channel')+':/channel','-v',str(root/'control')+':/control',
        '-v',str(Path(__file__).resolve())+':/broker.py:ro','--entrypoint','python3',image,'-I','-S','/broker.py','serve'],
        capture_output=True,text=True,check=True,timeout=30)
    cid=result.stdout.strip()
    (root/'control/resource-broker.json').write_text(json.dumps({'container':cid,'parent':str(parent),'task_container':container})+'\n')
    until=time.monotonic()+20
    while time.monotonic()<until:
        if (root/'control/resource-ready.json').exists():return config
        time.sleep(.1)
    logs=subprocess.run(['docker','logs',cid],capture_output=True,text=True,timeout=10)
    (root/'control/resource-start-error.log').write_text((logs.stdout+logs.stderr)[-8000:])
    stop(root,image)
    raise RuntimeError('Resource broker did not become ready')


def stop(root, image):
    root=Path(root)
    receipt=root/'control/resource-broker.json'
    if not receipt.exists():return
    config=json.loads(receipt.read_text())
    subprocess.run(['docker','rm','-f',config['container']],capture_output=True,text=True,timeout=30)
    parent=Path(config['parent'])
    if parent.exists():
        # The trusted cleanup helper sees only this task's slice. Never kills a
        # process or widens an agent budget; a nonempty native leaf fails cleanup.
        code="from pathlib import Path; import time; p=Path('/cgroup/native'); p.exists() and (p/'cgroup.kill').write_text('1'); time.sleep(.3); p.rmdir() if p.exists() else None"
        cleaned=subprocess.run(['docker','run','--rm','--user','0:0','--network','none','--read-only','--cap-drop','ALL',
            '-v',str(parent)+':/cgroup','--entrypoint','python3',image,'-I','-S','-c',code],capture_output=True,text=True,timeout=30)
        (root/'control/resource-cleanup.json').write_text(json.dumps({'returncode':cleaned.returncode,'error':cleaned.stderr[-1000:]})+'\n')


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['serve']);parser.parse_args()
    Broker(json.loads(Path('/control/resource-config.json').read_text())).serve_forever(poll_interval=.1)
