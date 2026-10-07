# check=skip=FromPlatformFlagConstDisallowed

FROM --platform=linux/amd64 emscripten/emsdk:4.0.9@sha256:3c853ef9c3b4c2708da1adac2fdfdba49c775fdc4144ceef4989423963e96811 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq make openssl \
    && rm -rf /var/lib/apt/lists/*

ARG WA_SQLITE_COMMIT=e4bb5532c8cfa9fa80bb26e62cc22814d16440be
WORKDIR /wa-sqlite
RUN git init -q \
    && git fetch -q --depth 1 https://github.com/powersync-ja/wa-sqlite.git "${WA_SQLITE_COMMIT}" \
    && git checkout -q FETCH_HEAD \
    && node scripts/download-core-build.js \
    && make deps/version-3.53.0/sqlite3.c \
    && printf '%s\n' \
        '4898210a5d532d374cba71682f8030fc9538fa57961e1686b2d7a0d1bb78370c  powersync-libs/libpowersync-wasm.a' \
        'c94657c2a08ed5f3f61a25f0018eb2f64ec42fd053da26d741db9e52e6ffaa77  deps/version-3.53.0/sqlite3.c' \
    | sha256sum -c -

ARG SQLITE_MAX_ATTACHED=125
RUN make dist/wa-sqlite.mjs WASQLITE_EXTRA_DEFINES=-DSQLITE_MAX_ATTACHED=${SQLITE_MAX_ATTACHED}

FROM scratch
COPY --chmod=0644 --from=build /wa-sqlite/dist/wa-sqlite.mjs /wa-sqlite/dist/wa-sqlite.wasm /
