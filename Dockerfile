# Een super lichtgewicht webserver
FROM nginx:alpine

# Kopieer de html file naar de standaard nginx map
COPY *.* /usr/share/nginx/html/

# Nginx draait standaard op poort 80
EXPOSE 80
