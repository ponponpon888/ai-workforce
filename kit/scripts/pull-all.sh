#!/bin/sh
# pull-all.sh -- Bring every repository under a root directory up to date,
# without ever touching work in progress.
#
# POSIX shell twin of pull-all.mjs and pull-all.ps1. Same options, same log
# lines, same exit codes; test-pull-all.mjs runs the identical fixture against
# all three with --target sh. This one exists for machines where you do not
# want Node in the login path, or where it is not installed at all.
#
# RULES, in order of importance:
#   - Never stash. Never reset. Never checkout. Never merge.
#   - A dirty working tree is skipped entirely.
#   - A repo mid-rebase, mid-merge, mid-cherry-pick, mid-bisect, or on a
#     detached HEAD is skipped.
#   - On the default branch with a clean tree: fast-forward-only pull.
#   - On a feature branch: a remote fetch followed by a local fast-forward
#     advances the local default branch without leaving the branch you are on.
#     If that would not fast-forward, git refuses and the repo is reported,
#     not forced.
#
# The whole point is that this can run unattended and still never lose a line
# of your work. If it cannot act safely, it reports and moves on.
#
#   sh pull-all.sh --root ~/Dev
#   sh pull-all.sh --root ~/Dev --repos api,web,infra
#   sh pull-all.sh --root ~/Dev --dry-run
#
# ONE DELIBERATE DIFFERENCE from the Node twin: log pruning is done with
# `find -mtime`, which measures age in whole days, where the Node version
# compares milliseconds. A log file is therefore removed on the same day the
# Node version would remove it, not at the same minute. Pruning old logs is
# not worth failing a run over (the Node version says so in a comment), and
# nothing in POSIX computes "now minus N days" portably.

set -u

# This runs unattended at login, so git has to fail rather than wait. Without
# these, a repository whose credentials have expired stops on a prompt nobody
# is there to answer, and the run hangs silently instead of reporting. The
# second one covers Git Credential Manager, which pops a window of its own
# that GIT_TERMINAL_PROMPT does not reach.
GIT_TERMINAL_PROMPT=0
GCM_INTERACTIVE=never
export GIT_TERMINAL_PROMPT GCM_INTERACTIVE

NL='
'

usage_error() {
    printf 'pull-all: %s\n' "$1" >&2
    exit 2
}

# --- arguments --------------------------------------------------------------

opt_root=''
opt_repos=''
opt_log_dir=''
opt_retention=''
dry_run=0
quiet=0
seen_root=0
seen_repos=0
seen_log_dir=0
seen_retention=0
seen_dry_run=0
seen_quiet=0

require_value() {
    # $1 = option name, $2 = how many arguments are left, $3 = the candidate
    if [ "$2" -lt 2 ]; then usage_error "missing value: $1"; fi
    case "$3" in
        --*) usage_error "missing value: $1" ;;
    esac
    # An empty or whitespace-only value is a missing value, not a value.
    case "$(printf '%s' "$3" | tr -d '[:space:]')" in
        '') usage_error "missing value: $1" ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)
            if [ "$seen_dry_run" -eq 1 ]; then usage_error 'duplicate option: --dry-run'; fi
            seen_dry_run=1
            dry_run=1
            ;;
        --quiet)
            if [ "$seen_quiet" -eq 1 ]; then usage_error 'duplicate option: --quiet'; fi
            seen_quiet=1
            quiet=1
            ;;
        --root)
            if [ "$seen_root" -eq 1 ]; then usage_error 'duplicate option: --root'; fi
            require_value --root "$#" "${2-}"
            seen_root=1
            opt_root=$2
            shift
            ;;
        --repos)
            if [ "$seen_repos" -eq 1 ]; then usage_error 'duplicate option: --repos'; fi
            require_value --repos "$#" "${2-}"
            seen_repos=1
            opt_repos=$2
            shift
            ;;
        --log-dir)
            if [ "$seen_log_dir" -eq 1 ]; then usage_error 'duplicate option: --log-dir'; fi
            require_value --log-dir "$#" "${2-}"
            seen_log_dir=1
            opt_log_dir=$2
            shift
            ;;
        --retention-days)
            if [ "$seen_retention" -eq 1 ]; then usage_error 'duplicate option: --retention-days'; fi
            require_value --retention-days "$#" "${2-}"
            seen_retention=1
            opt_retention=$2
            shift
            ;;
        *)
            usage_error 'unknown option or positional argument'
            ;;
    esac
    shift
done

# Absolute, without requiring realpath: a relative path is read against the
# working directory, exactly as the Node twin's resolve() does.
absolute_path() {
    case "$1" in
        /*) printf '%s' "$1" ;;
        *) printf '%s/%s' "$(pwd -P)" "$1" ;;
    esac
}

if [ -z "$opt_root" ]; then
    opt_root="$HOME/Dev"
fi
case "$opt_root" in
    '~') opt_root=$HOME ;;
    '~/'*) opt_root="$HOME/${opt_root#'~/'}" ;;
esac
root=$(absolute_path "$opt_root")

repo_names=''
if [ "$seen_repos" -eq 1 ]; then
    # A comma with nothing after it is an empty entry, but command
    # substitution strips the trailing newline it turns into, so the loop
    # below would never see it. Decide those three shapes up front.
    case "$opt_repos" in
        ,* | *, | *,,*)
            usage_error '--repos must contain direct child directory names separated by commas'
            ;;
    esac
    split_names=$(printf '%s' "$opt_repos" | tr ',' "$NL")
    while IFS= read -r raw_name; do
        name=$(printf '%s' "$raw_name" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        case "$name" in
            '' | '.' | '..' | */* | *\\* | *:*)
                usage_error '--repos must contain direct child directory names separated by commas'
                ;;
        esac
        # The same selection twice is one repository, as in the Node twin.
        case "$NL$repo_names" in
            *"$NL$name$NL"*) continue ;;
        esac
        repo_names="$repo_names$name$NL"
    done <<EOF
$split_names
EOF
fi

retention_text=${opt_retention:-30}
case "$retention_text" in
    '' | *[!0-9]*) usage_error '--retention-days must be a positive safe integer' ;;
esac
if [ "$retention_text" -lt 1 ] 2>/dev/null; then
    usage_error '--retention-days must be a positive safe integer'
fi
retention_days=$retention_text

# Check before mkdir(log_dir): the default log directory is inside root,
# so creating it first would silently create a misspelled/missing root too.
if [ ! -d "$root" ]; then
    printf 'pull-all: Root must be an existing directory. Nothing was updated.\n' >&2
    exit 1
fi

if [ -n "$opt_log_dir" ]; then
    log_dir=$(absolute_path "$opt_log_dir")
else
    log_dir="$root/_logs"
fi

# --- explicit selection -----------------------------------------------------

# Explicit selections must all be usable before updating any member of the
# batch. Keep auto-discovery permissive; users may store non-repository
# folders there.
requested=''
if [ "$seen_repos" -eq 1 ]; then
    while IFS= read -r name || [ -n "$name" ]; do
        [ -n "$name" ] || continue
        requested="$requested$root/$name$NL"
    done <<EOF
$repo_names
EOF

    while IFS= read -r target || [ -n "$target" ]; do
        [ -n "$target" ] || continue
        if [ -d "$target" ] && [ -e "$target/.git" ] &&
            git -C "$target" rev-parse --absolute-git-dir >/dev/null 2>&1 </dev/null; then
            continue
        fi
        printf 'pull-all: Invalid requested repository: %s. Nothing was updated.\n' \
            "$(basename "$target")" >&2
        exit 1
    done <<EOF
$requested
EOF
fi

# --- logging ----------------------------------------------------------------

if [ "$dry_run" -eq 1 ]; then
    GIT_OPTIONAL_LOCKS=0
    export GIT_OPTIONAL_LOCKS
else
    if ! mkdir -p "$log_dir" 2>/dev/null; then
        printf 'pull-all: Cannot create log directory. Stopping.\n' >&2
        exit 1
    fi
fi
log_file="$log_dir/pull-all_$(date +%Y%m%d%H%M%S).log"

log() {
    log_line="$(date +%H:%M:%S)  $1"
    if [ "$quiet" -eq 0 ]; then
        printf '%s\n' "$log_line"
    fi
    if [ "$dry_run" -eq 0 ]; then
        if ! printf '%s\n' "$log_line" >>"$log_file" 2>/dev/null; then
            printf 'pull-all: Cannot write log. Stopping.\n' >&2
            exit 1
        fi
    fi
}

# Runs git in a repository and leaves the result in git_out / git_code, so a
# caller can read both without a subshell swallowing the exit status.
#
# </dev/null is load-bearing: the repository loop reads its list from a
# here-document, so anything git decided to read from stdin would eat the
# repositories that have not been processed yet.
git_run() {
    git_run_dir=$1
    shift
    git_out=$(git -C "$git_run_dir" "$@" 2>&1 </dev/null)
    git_code=$?
}

# --- discovery --------------------------------------------------------------

if ! git --version >/dev/null 2>&1 </dev/null; then
    log 'git not found on PATH. Nothing to do.'
    exit 1
fi

targets=''
target_count=0
if [ "$seen_repos" -eq 1 ]; then
    targets=$requested
else
    # find rather than a glob: a repository directory whose name starts with a
    # dot is still a repository, and `"$root"/*` would not see it.
    discovered=$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)
    while IFS= read -r entry || [ -n "$entry" ]; do
        [ -n "$entry" ] || continue
        [ -e "$entry/.git" ] || continue
        targets="$targets$entry$NL"
    done <<EOF
$discovered
EOF
fi
if [ -n "$targets" ]; then
    target_count=$(printf '%s' "$targets" | grep -c '')
fi

if [ "$dry_run" -eq 1 ]; then
    log "pull-all start  root=$root  repos=$target_count  (dry run)"
else
    log "pull-all start  root=$root  repos=$target_count"
fi

# --- the work ---------------------------------------------------------------

IN_PROGRESS='rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD sequencer BISECT_LOG'
summary=''
failed=0

record() {
    # $1 = repository name, $2 = result. The separator below is a literal tab,
    # which the summary loop reads back with IFS; a repository name can contain
    # a space, so a space would not survive the round trip.
    summary="$summary$1	$2$NL"
    case "$2" in
        fail*) failed=1 ;;
    esac
}

while IFS= read -r repo || [ -n "$repo" ]; do
    [ -n "$repo" ] || continue
    name=$(basename "$repo")

    # Resolve the real git dir: `.git` can be a file (worktrees, submodules).
    git_run "$repo" rev-parse --absolute-git-dir
    if [ "$git_code" -ne 0 ]; then
        log "$name : SKIP (not a git repo)"
        record "$name" 'skip/not-a-repo'
        continue
    fi
    git_dir=$git_out

    busy=''
    for marker in $IN_PROGRESS; do
        if [ -e "$git_dir/$marker" ]; then
            if [ -n "$busy" ]; then busy="$busy, $marker"; else busy=$marker; fi
        fi
    done
    if [ -n "$busy" ]; then
        log "$name : SKIP (in progress: $busy)"
        record "$name" 'skip/in-progress'
        continue
    fi

    git_run "$repo" status --porcelain --untracked-files=all --ignore-submodules=none
    if [ "$git_code" -ne 0 ]; then
        log "$name : FAILED reading working tree status -- $git_out"
        record "$name" 'fail/status'
        continue
    fi
    if [ -n "$git_out" ]; then
        log "$name : SKIP (dirty working tree)"
        record "$name" 'skip/dirty'
        continue
    fi

    git_run "$repo" rev-parse --abbrev-ref HEAD
    if [ "$git_code" -ne 0 ] || [ -z "$git_out" ]; then
        log "$name : FAILED reading current branch -- $git_out"
        record "$name" 'fail/branch'
        continue
    fi
    branch=$git_out
    if [ "$branch" = 'HEAD' ]; then
        log "$name : SKIP (detached HEAD)"
        record "$name" 'skip/detached'
        continue
    fi

    git_run "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD
    case "$git_out" in
        origin/?*) def=${git_out#origin/} ;;
        *) def=main ;;
    esac

    if [ "$dry_run" -eq 1 ]; then
        if [ "$branch" = "$def" ]; then
            log "$name : would pull --ff-only on '$def'"
        else
            log "$name : would fetch origin $def:$def (on '$branch')"
        fi
        record "$name" 'dry-run'
        continue
    fi

    if [ "$branch" = "$def" ]; then
        git_run "$repo" pull --ff-only
        if [ "$git_code" -eq 0 ]; then
            log "$name : ok ($def fast-forwarded)"
            record "$name" 'ok'
        else
            log "$name : FAILED ff-only pull -- $git_out"
            record "$name" 'fail/pull'
        fi
        continue
    fi

    # Separate transport failure from a refused local fast-forward. Never
    # classify authentication/network errors as normal divergent-history skips.
    git_run "$repo" fetch --no-tags origin "$def"
    if [ "$git_code" -ne 0 ]; then
        log "$name : FAILED fetch -- $git_out"
        record "$name" 'fail/fetch'
        continue
    fi
    git_run "$repo" rev-parse --verify 'FETCH_HEAD^{commit}'
    if [ "$git_code" -ne 0 ]; then
        log "$name : FAILED resolving fetched commit -- $git_out"
        record "$name" 'fail/fetch'
        continue
    fi
    fetched_head=$git_out

    # A local fetch still enforces fast-forward and checked-out-branch safety.
    git_run "$repo" fetch --no-tags . "$fetched_head:refs/heads/$def"
    if [ "$git_code" -eq 0 ]; then
        log "$name : ok (on '$branch', $def advanced)"
        record "$name" 'ok/branch'
    else
        update_out=$git_out
        git_run "$repo" merge-base --is-ancestor "refs/heads/$def" "$fetched_head"
        if [ "$git_code" -eq 1 ]; then
            log "$name : $def not fast-forwardable, left alone -- $update_out"
            record "$name" 'skip/diverged'
        else
            log "$name : FAILED local branch update -- $update_out"
            record "$name" 'fail/update'
        fi
    fi
done <<EOF
$targets
EOF

# --- wrap up ----------------------------------------------------------------

log '--- summary ---'
while IFS='	' read -r summary_name summary_result || [ -n "$summary_name" ]; do
    [ -n "$summary_name" ] || continue
    log "$(printf '%-28s %s' "$summary_name" "$summary_result")"
done <<EOF
$summary
EOF

# Pruning old logs is not worth failing the run over.
if [ "$dry_run" -eq 0 ]; then
    find "$log_dir" -mindepth 1 -maxdepth 1 -type f -name 'pull-all_*.log' \
        -mtime "+$((retention_days - 1))" -exec rm -f {} + 2>/dev/null || :
fi

if [ "$dry_run" -eq 1 ]; then
    log 'done. dry run: no log file written.'
else
    log "done. log: $log_file"
fi

# Non-zero only when something actually failed. Skips are the normal, safe path.
if [ "$failed" -eq 1 ]; then
    exit 1
fi
exit 0
