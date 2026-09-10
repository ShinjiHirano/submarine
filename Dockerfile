FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css ships.json equipment.json scenario.json /usr/share/nginx/html/game/submarine/
COPY src /usr/share/nginx/html/game/submarine/src
COPY scenarios /usr/share/nginx/html/game/submarine/scenarios
COPY assets /usr/share/nginx/html/game/submarine/assets

EXPOSE 80
