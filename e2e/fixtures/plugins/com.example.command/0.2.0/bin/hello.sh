#!/bin/sh
# Prints its arguments and the environment variable GREETING (a tiny program the package brings along).
echo "hello $*"
echo "GREETING=${GREETING:-}"
