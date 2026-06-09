#!/bin/bash

CWD=$(pwd)

rm -rf src/assets/*/

if [[ "$CI" == "true" ]]; then
	REMOTE="https://x-access-token:$PAT@github.com/brianjenkins94/assets.git"
else
	REMOTE="https://github.com/brianjenkins94/assets.git"
fi

git clone --no-checkout --depth 1 --filter=tree:0 --sparse "$REMOTE" || exit 1

cd assets/

git sparse-checkout set docs/war2/

git checkout

cd ..

mkdir -p src/assets

find src/assets -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

cp -rf assets/docs/war2/. src/assets/

rm -rf assets/

cd "$CWD"
