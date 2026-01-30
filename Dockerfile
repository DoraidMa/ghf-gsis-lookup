FROM node:20-alpine

WORKDIR /app
COPY package.json package.json
RUN npm install --omit=dev

COPY server.js server.js

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["npm", "start"]