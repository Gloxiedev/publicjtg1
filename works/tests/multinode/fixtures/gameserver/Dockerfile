FROM node:22-alpine

ENV SERVER_PORT=25565 \
    SERVER_NAME=server \
    SERVER_MEMORY=1024 \
    JTG_NODE_ID=unknown

WORKDIR /srv
COPY server.js /srv/server.js

EXPOSE 25565

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["node /srv/server.js"]