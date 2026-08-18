FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY scripts ./scripts
COPY data ./data
COPY public ./public
EXPOSE 3459
CMD ["node", "server.js"]
