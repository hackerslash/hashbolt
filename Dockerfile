FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js configure.html ./
ENV PORT=7001 DATA_FILE=/data/data.tsv
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 7001
HEALTHCHECK --start-period=5m CMD wget -qO- http://localhost:7001/health || exit 1
USER node
CMD ["node", "server.js"]
