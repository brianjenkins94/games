#!/bin/bash

CWD=$(pwd)

rm -rf src/assets/*/

git clone --no-checkout --depth 1 --filter=tree:0 --sparse https://github.com/brianjenkins94/assets.git

cd assets/

git sparse-checkout set docs/war2/

git checkout

cd ..

mkdir -p src/assets

find src/assets -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

cp -rf assets/docs/war2/. src/assets/

rm -rf assets/

cd "$CWD"
