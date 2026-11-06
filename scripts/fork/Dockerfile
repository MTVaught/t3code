FROM rockylinux@sha256:9794037624aaa6212aeada1d28861ef5e0a935adaf93e4ef79837119f2a2d04c AS base
RUN dnf install -y ca-certificates libstdc++ libgcc binutils findutils tar gzip python3.11 curl \
    && dnf clean all
ENV T3CODE_TELEMETRY_ENABLED=false DO_NOT_TRACK=1
WORKDIR /workspace

FROM base AS node
RUN dnf install -y xz && dnf clean all
ARG NODE_VERSION=26.12.1
RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c - \
    && mkdir /opt/node \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" SHASUMS256.txt
FROM node AS builder
RUN dnf install -y git gcc gcc-c++ make python3.11 perl-core cmake xz openssl-devel libatomic \
    && dnf clean all
ARG RUST_VERSION=1.99.1
RUN curl -fsSLO "https://static.rust-lang.org/dist/rust-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" \
    && curl -fsSLO "https://static.rust-lang.org/dist/rust-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz.sha256" \
    && sha256sum -c "rust-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz.sha256" \
    && tar -xJf "rust-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" \
    && "rust-${RUST_VERSION}-x86_64-unknown-linux-gnu/install.sh" --prefix=/opt/rust --without=rust-docs \
    && rm -rf "rust-${RUST_VERSION}-x86_64-unknown-linux-gnu"*
ENV PATH=/opt/node/bin:/opt/rust/bin:$PATH PYTHON=/usr/bin/python3.11

FROM base AS runtime
# This Node binary is only a native-module test driver. The CLI is tested with PATH empty.
COPY --from=node /opt/node/bin/node /opt/test-node/node
