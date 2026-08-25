#!/bin/sh
# Hilbert's hosted mode wants a sign-in secret before it will bind anything.
# Making one up beats starting without one, but a token that changes on every
# restart also throws away every session and the live-collaboration room key,
# so say so loudly enough that anyone keeping the container around sets one.
set -eu

if [ -z "${HILBERT_SERVER_TOKEN:-}" ]; then
    HILBERT_SERVER_TOKEN="$(head -c 36 /dev/urandom | base64 | tr -d '\n=+/')"
    export HILBERT_SERVER_TOKEN
    echo
    echo "  No HILBERT_SERVER_TOKEN was set, so this container generated one."
    echo "  Sign in with:"
    echo
    echo "      ${HILBERT_SERVER_TOKEN}"
    echo
    echo "  It is different every time the container starts. Pass"
    echo "  -e HILBERT_SERVER_TOKEN=... to keep your sessions across restarts."
    echo
fi

if ! mkdir -p "${TYPST_WORKSPACE}" 2>/dev/null || [ ! -w "${TYPST_WORKSPACE}" ]; then
    echo "  ${TYPST_WORKSPACE} is not writable by uid $(id -u)." >&2
    echo "  Mount a folder this user owns, or add --user \"\$(id -u):\$(id -g)\"." >&2
    exit 1
fi

# Settings and the activity log go to HOME. Running the container under some
# other uid than the one the image was built for leaves that unwritable, and
# the workspace is the one place known to be writable in that case.
if ! mkdir -p "${HOME}" 2>/dev/null || [ ! -w "${HOME}" ]; then
    HOME="${TYPST_WORKSPACE}/.hilbert/home"
    export HOME
    mkdir -p "${HOME}"
fi

exec hilbert --serve \
    --bind "${HILBERT_BIND}" \
    --port "${HILBERT_PORT}" \
    --workspace "${TYPST_WORKSPACE}"
