#!/bin/bash
set -euo pipefail

install_node_dependencies() {
    local dir="$1"
    [ -f "$dir/package.json" ] || return 0
    (
        cd "$dir"
        if [ -f pnpm-lock.yaml ] || [ -f pnpm-workspace.yaml ]; then
            if [ -f pnpm-lock.yaml ]; then
                corepack pnpm install --frozen-lockfile
            else
                corepack pnpm install
            fi
        elif [ -f yarn.lock ]; then
            corepack yarn install --immutable
        elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
            npm ci
        else
            npm install
        fi
    )
}

prewarm_repository() {
    local url="$1" dir="$2" revision="$3"
    echo "Pre-cloning $url at $revision into $dir"
    git clone --depth 1 --config core.fsmonitor=false "$url" "$dir"
    # Resolve the exact revision selected by build.sh, even if main moved while
    # the earlier image layers were building.
    if [ -n "$revision" ] && [ "$(git -C "$dir" rev-parse HEAD)" != "$revision" ]; then
        git -C "$dir" fetch --depth 1 origin "$revision"
        git -C "$dir" reset --hard FETCH_HEAD
    fi
    git -C "$dir" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

    for project in "$dir" "$dir/alakazam"; do
        if [ -f "$project/pyproject.toml" ] && { [ -f "$project/poetry.lock" ] || grep -Eq '^\[tool\.poetry(\.|])' "$project/pyproject.toml"; }; then
            echo "Pre-installing Poetry dependencies in $project"
            (cd "$project" && POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --no-interaction --no-ansi)
        fi
    done
    install_node_dependencies "$dir"
    touch /workspace/.build-cloned
}

if [ -n "${GIT_REPO_URL:-}" ]; then
    target="/workspace/${GIT_CLONE_DIR:-$(basename "$GIT_REPO_URL" .git)}"
    prewarm_repository "$GIT_REPO_URL" "$target" "$GIT_REVISION"
    if [ -n "${NPM_INSTALL_DIR:-}" ] && [ "$NPM_INSTALL_DIR" != "." ]; then
        install_node_dependencies "$target/$NPM_INSTALL_DIR"
    fi
fi

if [ -n "${OPENDEX_REVISION:-}" ]; then
    if [ -d /workspace/opendex/.git ]; then
        echo "OpenDex is already the primary repository"
    else
        prewarm_repository git@github.com:decisional/opendex.git /workspace/opendex "$OPENDEX_REVISION"
    fi
fi
