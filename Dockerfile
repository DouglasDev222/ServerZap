# Dockerfile recomendado para Puppeteer no Render.com
# Usa a imagem oficial do Puppeteer, que já vem com Google Chrome + deps
FROM ghcr.io/puppeteer/puppeteer:22.6.3

# Define o diretório de trabalho
WORKDIR /app

# Define o usuário para 'pptruser' (usuário padrão da imagem Puppeteer)
USER pptruser

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências da sua aplicação
# Usamos 'npm ci' para instalações limpas e 'npm install' como fallback
RUN npm ci --only=production || npm install --production

# Copia o restante dos arquivos da sua aplicação
COPY . .

# Expõe a porta que sua aplicação usa
EXPOSE ${PORT:-10000}

# Comando para iniciar a aplicação
CMD ["node", "index.js"]
