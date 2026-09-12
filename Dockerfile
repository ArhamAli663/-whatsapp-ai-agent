FROM node:24-bullseye-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --no-audit
COPY . .
EXPOSE 7860
ENV NODE_ENV=production
ENV PORT=7860
CMD ["node", "src/server.js"]
