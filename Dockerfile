# Gebruik een lichte Node image
FROM node:18-alpine

# Werkmap in de container
WORKDIR /app

# Kopieer package bestanden en installeer dependencies
COPY package.json ./
RUN npm install

# Kopieer de rest van de broncode
COPY . .

# Maak een map voor de database data
RUN mkdir -p /app/data

# Stel de poort in
EXPOSE 3000

# Start commando
CMD ["npm", "start"]
