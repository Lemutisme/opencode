#!/usr/bin/env bash
# Thin, issuer-owned OS operations. Kernel decisions remain in ota-rsi.ts.
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "$0")" && pwd -P)
action=$1; shift
root=$(realpath -e -- "$1"); shift
label=$(printf %s "$root" | sha256sum | cut -d' ' -f1)
docker() { env -i PATH="$PATH" HOME=/nonexistent DOCKER_CONFIG=/nonexistent docker "$@"; }
regular() { [[ -f "$1" && ! -L "$1" && "$1" != *','* && "$1" = /* ]] || exit 65; }

case "$action" in
  fence)
    listed=$(docker ps -aq --filter "label=opencode.ota=$label")
    if [[ -n "$listed" ]]; then mapfile -t ids <<< "$listed"; docker rm -f "${ids[@]}" >/dev/null; fi
    remaining=$(docker ps -aq --filter "label=opencode.ota=$label")
    [[ -z "$remaining" ]]
    ;;
  fork-state)
    running=$(docker ps -q --filter "label=opencode.ota=$label")
    [[ -z "$running" ]] || { echo 'writers are not fenced' >&2; exit 65; }
    python3 -I "$here/ota-files.py" fork "$@"
    ;;
  build)
    image=$1; source=$2; dependencies=$3; bun=$4; models=$5; patch=$6; output=$7
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 65
    for file in "$source" "$dependencies" "$bun" "$models" "$patch"; do regular "$file"; done
    mkdir -- "$output"
    name="ota-build-${label:0:12}-$(cat /proc/sys/kernel/random/uuid)"
    phase=admission
    cleanup() {
      code=$?
      state=$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}}' "$name" 2>/dev/null) || state=unknown
      cleaned=false
      if docker rm -f "$name" >/dev/null 2>&1; then cleaned=true; fi
      printf '{"phase":"%s","exit_code":%d,"container_state":"%s","cleanup_confirmed":%s}\n' "$phase" "$code" "$state" "$cleaned" > "$output/result.json"
      return "$code"
    }
    trap cleanup EXIT
    trap 'exit 143' TERM INT HUP
    docker create --name "$name" --pull never --label "opencode.ota=$label" \
      --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --user "$(id -u):$(id -g)" --pids-limit 512 --memory 16g --memory-swap 16g --cpus 4 \
      --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g,mode=1777 \
      --tmpfs "/work:rw,exec,nosuid,nodev,size=10g,uid=$(id -u),gid=$(id -g),mode=0700" \
      --tmpfs "/output:rw,nosuid,nodev,size=1g,uid=$(id -u),gid=$(id -g),mode=0700" \
      --mount "type=bind,src=$source,dst=/inputs/source.tar,readonly" \
      --mount "type=bind,src=$dependencies,dst=/inputs/dependencies.tar,readonly" \
      --mount "type=bind,src=$bun,dst=/inputs/bun,readonly" \
      --mount "type=bind,src=$models,dst=/inputs/models.json,readonly" \
      --mount "type=bind,src=$patch,dst=/inputs/change.patch,readonly" \
      --mount "type=bind,src=$here/ota-files.py,dst=/trusted/files.py,readonly" \
      --env HOME=/tmp --env TMPDIR=/tmp --env OPENCODE_VERSION=0.0.0-ota \
      --env OPENCODE_CHANNEL=ota --env MODELS_DEV_API_JSON=/inputs/models.json \
      --entrypoint /bin/sh "$image" -c 'sleep 21660' > "$output/container"
    docker start "$name" >/dev/null
    phase=source
    timeout --signal=TERM --kill-after=10s 1200s docker exec "$name" /bin/sh -eu -c '
      mkdir /work/repo
      tar -xf /inputs/source.tar -C /work/repo
      cd /work/repo
      export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
      git -c core.hooksPath=/dev/null init -q
      git -c core.hooksPath=/dev/null add --force --all
      if [ -s /inputs/change.patch ]; then git -c core.hooksPath=/dev/null apply --index --whitespace=nowarn /inputs/change.patch; fi
      git -c core.hooksPath=/dev/null -c user.name=OTA -c user.email=ota@localhost -c commit.gpgsign=false commit -qm source
      # Export actual tracked bytes, not candidate-controlled export-ignore/subst.
      python3 -I /trusted/files.py source /work/repo /output/source.tar
    ' 2>&1 | head -c 16777217 > "$output/source.log"
    phase=export-source
    docker exec "$name" /bin/tar -C /output -cf - -- source.tar | python3 -I "$here/ota-files.py" export "$output/source.tar" source.tar 1073741824
    phase=compile
    timeout --signal=TERM --kill-after=10s 1200s docker exec "$name" /bin/sh -eu -c '
      cd /work/repo
      tar -xf /inputs/dependencies.tar -C /work/repo
      export PATH=/inputs:$PATH
      bun packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui
      cp packages/opencode/dist/opencode-linux-x64/bin/opencode /output/opencode
    ' 2>&1 | head -c 16777217 > "$output/build.log"
    phase=export-binary
    # Export data through a strict tar reader; never unpack candidate tar on host.
    docker exec "$name" /bin/tar -C /output -cf - -- opencode | python3 -I "$here/ota-files.py" export "$output/opencode" opencode 536870912
    phase=complete
    ;;
  *) echo 'usage: ota-release.sh {build|fence|fork-state} ROOT ...' >&2; exit 64 ;;
esac
