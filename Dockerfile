FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000
ENV NODE_ENV=production
ENV RENDER=true

EXPOSE 3000
CMD ["npm", "start"]
