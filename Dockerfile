FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY backend ./backend
COPY frontend ./frontend
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node","backend/index.mjs"]
