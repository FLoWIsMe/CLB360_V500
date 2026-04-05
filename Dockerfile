FROM node:20-alpine

# Chromium for PDF/PNG report generation
RUN apk add --no-cache chromium font-noto-cjk \
  && ln -sf /usr/bin/chromium-browser /usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
ENV CHROME_PATH=/usr/bin/chromium-browser

EXPOSE 8080

CMD ["node", "server.js"]
