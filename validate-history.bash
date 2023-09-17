#!/usr/bin/env bash

trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT

for dir in history/*.*.*/
do
    VERSION=$(basename "$dir")
    for SCHEMA in "$dir"*"-schema.json"
    do 
        if [[ -f "$SCHEMA" ]]
        then
            echo validating $SCHEMA
            npx tsx src/validate.ts -v "$VERSION" -s "$SCHEMA" --historical --quiet
        fi
    done &
done

wait
