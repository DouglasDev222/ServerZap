FROM node:18-alpine

WORKDIR /app

# Instalar dependências do Puppeteerr
RUN apk add --no-cache chromium nss freetype freetype-dev harfbuzz ca-certificates \
    ttf-freefont fontconfig udev

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE ${PORT:-5000}

CMD ["node", "index.js"]
