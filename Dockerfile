# Use a imagem oficial do Node.js que já inclui o Puppeteer e suas dependências
FROM ghcr.io/puppeteer/puppeteer:22.6.3

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências da sua aplicação
RUN npm install

# Copia o restante dos arquivos da sua aplicação
COPY . .

# Expõe a porta que sua aplicação usa
EXPOSE ${PORT:-10000}

# Comando para iniciar a aplicação
CMD ["node", "index.js"]
