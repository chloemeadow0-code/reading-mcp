FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
RUN cp -R data.example data || true
ENV READING_MCP_DATA_DIR=/app/data
ENV MCP_SSE_HOST=0.0.0.0
EXPOSE 3100
CMD ["npm", "run", "start:sse"]
