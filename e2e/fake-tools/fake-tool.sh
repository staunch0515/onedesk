#!/bin/sh
# Fake ssh / scp / docker for the e2e specs. Installed once per tool name (the file name decides the tool).
# State directory (set by e2e/fake-tools.ts when it writes this file): __STATE__
# - every call is recorded in $STATE/calls/<seq>-<tool>.args (one argument per line, NUL-free) plus .stdin
# - rules: $STATE/rules/<tool>/<NN>/{match,steps,code,mode,env}; the first whose `match` (extended regex, tested
#   against the arguments joined with single spaces) fits is used; none fits -> exit 127 and a message on stderr.
#   steps: lines `out TEXT` | `err TEXT` | `sleep SECONDS` (executed in order); code: exit status.
#   mode `exec` (ssh): run the remote command in a local shell inside $STATE/remote-home, PATH from $STATE/path.
#   mode `docker-exec` / `docker-cp` (docker): run the command given to `exec` locally / copy `cp` to $STATE/container-fs.
#   mode `scp`: copy host:path (resolved inside $STATE/remote-home) to the local target.
#   env: lines KEY=VALUE exported before running (e.g. PGPASSWORD for the remote pg_dump).
STATE="__STATE__"
PATH=/usr/bin:/bin
tool=$(basename "$0")
mkdir -p "$STATE/calls" "$STATE/remote-home" "$STATE/container-fs"
seq=$(ls "$STATE/calls" | wc -l | tr -d ' ')
seq=$(printf '%06d' "$seq")
rec="$STATE/calls/$seq-$tool"
: > "$rec.args"
for a in "$@"; do printf '%s\n' "$a" >> "$rec.args"; done
joined="$*"
chosen=""
for d in "$STATE/rules/$tool"/*/; do
  [ -d "$d" ] || continue
  pat=".*"; [ -f "$d/match" ] && pat=$(cat "$d/match")
  if printf '%s' "$joined" | grep -Eq -- "$pat"; then chosen="$d"; break; fi
done
if [ -z "$chosen" ]; then
  echo "fake $tool: no rule for: $joined" >&2
  exit 127
fi
mode=script; [ -f "$chosen/mode" ] && mode=$(cat "$chosen/mode")
code=0; [ -f "$chosen/code" ] && code=$(cat "$chosen/code")
if [ -f "$chosen/env" ]; then
  while IFS= read -r line; do [ -n "$line" ] && export "$line"; done < "$chosen/env"
fi
pgpath=""; [ -f "$STATE/path" ] && pgpath=$(cat "$STATE/path")

run_steps() {
  [ -f "$chosen/steps" ] || return 0
  while IFS= read -r line; do
    kind=${line%% *}; rest=${line#* }; [ "$kind" = "$line" ] && rest=""
    case "$kind" in
      out) printf '%b\n' "$rest" ;;
      err) printf '%b\n' "$rest" >&2 ;;
      sleep) sleep "$rest" ;;
    esac
  done < "$chosen/steps"
}

case "$mode" in
  script)
    run_steps
    exit "$code"
    ;;
  exec)
    # ssh [options] host command...: options that take a value are skipped, the first other word is the host.
    while [ $# -gt 0 ]; do
      case "$1" in
        --) shift; break ;;
        -[oplFiJLRDEbcemSWBIwO]) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    shift # the host
    [ "$1" = "--" ] && shift
    cd "$STATE/remote-home" || exit 255
    PATH="$STATE/remote-bin:$pgpath:/usr/bin:/bin" sh -c "$*"
    st=$?
    run_steps
    exit "$st"
    ;;
  scp)
    # scp [options] src dst: the side with `host:` is a path inside remote-home.
    while [ $# -gt 0 ]; do
      case "$1" in
        --) shift; break ;;
        -[PiFloJS]) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    src=$1; dst=$2
    case "$src" in *:*) src="$STATE/remote-home/${src#*:}" ;; esac
    case "$dst" in *:*) dst="$STATE/remote-home/${dst#*:}" ;; esac
    cp -R "$src" "$dst" || exit 1
    run_steps
    exit "$code"
    ;;
  docker-cp)
    # docker cp SRC CONTAINER:DST | CONTAINER:SRC DST ; container paths live in container-fs
    while [ $# -gt 0 ]; do case "$1" in cp) shift; break ;; *) shift ;; esac; done
    src=$1; dst=$2
    case "$src" in *:*) src="$STATE/container-fs/${src#*:}" ;; esac
    case "$dst" in *:*) dst="$STATE/container-fs/${dst#*:}"; mkdir -p "$(dirname "$dst")" ;; esac
    cp -R "$src" "$dst" || exit 1
    run_steps
    exit "$code"
    ;;
  docker-exec)
    # docker exec [options] CONTAINER command... ; run the command here, container paths mapped into container-fs
    while [ $# -gt 0 ]; do case "$1" in exec) shift; break ;; *) shift ;; esac; done
    while [ $# -gt 0 ]; do
      case "$1" in
        -[uewc]|--user|--env|--workdir) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    shift # the container name
    cd "$STATE/container-fs" || exit 255
    # paths the plugin keeps inside the container (/tmp/onedesk-*) live in container-fs
    n=$#
    while [ "$n" -gt 0 ]; do
      a=$1; shift
      case "$a" in /tmp/onedesk-*) a="$STATE/container-fs$a" ;; esac
      set -- "$@" "$a"
      n=$((n - 1))
    done
    PATH="$pgpath:/usr/bin:/bin" "$@"
    st=$?
    run_steps
    exit "$st"
    ;;
  *)
    echo "fake $tool: unknown mode $mode" >&2
    exit 126
    ;;
esac
