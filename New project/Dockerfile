FROM node:22-alpine
WORKDIR /app
COPY package.json server.js email-templates.js data.json index.html .env.example ./
EXPOSE 10000
CMD ["node","server.js"]
