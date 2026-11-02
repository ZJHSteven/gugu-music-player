# 零依赖：只用 Node 官方镜像，不需要 npm install
FROM node:22-alpine

WORKDIR /app

# 只拷需要的，保持镜像小
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# 数据目录（歌单与上传的音乐），用 volume 挂出来才持久
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8787
EXPOSE 8787

# 用 setup 脚本会尝试拉隧道，容器里不适合；直接起服务
CMD ["node", "server/index.js", "--port", "8787", "--data", "/app/data"]
