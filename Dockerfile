ARG NODE_VERSION=22

FROM node:${NODE_VERSION:-22}-alpine as builder

RUN apk update && apk upgrade

ENV WORKDIR="ts-workspace"

COPY ./bin/ $WORKDIR/bin/
COPY ./src/ $WORKDIR/src/
COPY ./tests/ $WORKDIR/tests/
COPY ./workdocs/reports $WORKDIR/workdocs/reports
COPY ./package*.json $WORKDIR/
COPY ./.mpmrc $WORKDIR/

# Install the dependencies from package-lock.json
# Make the workfolder available to the the 'node' user. The `node` user is built in the Node image.
RUN --mount=type=secret,id=TOKEN TOKEN=$(cat /run/secrets/TOKEN) npm ci && npm cache clean --force && chown -R node:node .

FROM node:${NODE_VERSION:-22}-alpine AS production

RUN apk update && apk upgrade
RUN apk --no-cache add htop less grep && apk add --no-cache --upgrade bash # optional but useful

ENV WORKDIR="ts-workspace"

ENV NODE_ENV="production"

#COPY --from=builder --chown=node:node $WORKDIR/dist $WORKDIR/ #one or the other usually
COPY --from=builder --chown=node:node $WORKDIR/lib $WORKDIR/lib/
COPY --from=builder --chown=node:node $WORKDIR/package*.json $WORKDIR/

USER node

WORKDIR $WORKDIR

# Install the dependencies from package-lock.json
# Make the workfolder available to the the 'node' user. The `node` user is built in the Node image.
RUN --mount=type=secret,id=TOKEN TOKEN=$(cat /run/secrets/TOKEN) npm ci && npm cache clean --force && chown -R node:node .


ENTRYPOINT ["node", "lib/cli.cjs"]

LABEL name="TS Workspace" description="Template Dockerfile for typescript projects"

