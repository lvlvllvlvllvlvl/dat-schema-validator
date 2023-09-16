#!/usr/bin/env bash

cd ../dat-schema
git checkout main
git checkout .
git clean -f

TZ=UTC git log --pretty='%h %cd' --date='format-local:%y-%m-%dT%H%M' 3728a7b -- dat-schema | while read line
do
    COMMIT_HASH="$(echo $line | cut -d ' ' -f1)"
    COMMIT_TIME="$(echo $line | cut -d ' ' -f2)"
    OUTPUT="../dat-schema-validator/history/dat-schema/${COMMIT_TIME}.json"
    [[ -f "$OUTPUT" ]] && continue
    echo $COMMIT_TIME $COMMIT_HASH
    git checkout "$COMMIT_HASH" --quiet
    npm i --silent
    npm exec tsc
    npm run generate --silent
    mv schema.min.json "$OUTPUT"
done
