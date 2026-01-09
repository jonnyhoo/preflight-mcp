FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制构建后的文件
COPY dist/ ./dist/
COPY package.json ./

# 创建非root用户
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# 设置权限
RUN chown -R nodejs:nodejs /app
USER nodejs

# 设置环境变量
ENV PREFLIGHT_STORAGE_DIR=/app/bundles
ENV PREFLIGHT_TMP_DIR=/tmp/preflight-mcp

# 创建必要目录
RUN mkdir -p /app/bundles /tmp/preflight-mcp

# 暴露端口 (如果需要HTTP接口)
EXPOSE 3000

# 启动命令
CMD ["node", "dist/index.js"]
