FROM nginx:alpine

COPY . /usr/share/nginx/html

# Fix permissions for all files (nginx needs read access)
RUN chmod -R 644 /usr/share/nginx/html/* && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} \;

# Clean up non-web files and backups
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/fly.toml \
          /usr/share/nginx/html/ROADMAP.md \
          /usr/share/nginx/html/*.bak \
          /usr/share/nginx/html/research_findings.md \
          /usr/share/nginx/html/GUIDE.md

# Gzip + cache headers
RUN printf 'server {\n\
    listen 8080 default_server;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript image/svg+xml image/webp;\n\
    location = /robots.txt {\n\
        add_header Content-Type text/plain;\n\
        add_header Cache-Control "public, max-age=3600";\n\
    }\n\
    location = /sitemap.xml {\n\
        add_header Content-Type application/xml;\n\
        add_header Cache-Control "public, max-age=3600";\n\
    }\n\
    location = /index.html {\n\
        return 301 /;\n\
    }\n\
    location ~* \\.md$ {\n\
        return 301 https://github.com/crewswarm/crewswarm;\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
        add_header Cache-Control "public, max-age=3600";\n\
    }\n\
    location ~* \\.(css|js)$ {\n\
        add_header Cache-Control "public, max-age=86400";\n\
    }\n\
    location ~* \\.webp$ {\n\
        add_header Cache-Control "public, max-age=604800";\n\
        expires 7d;\n\
        add_header Content-Type image/webp;\n\
    }\n\
    location ~* \\.(png|jpg|jpeg|gif|ico|svg|woff2)$ {\n\
        add_header Cache-Control "public, max-age=604800";\n\
        expires 7d;\n\
    }\n\
    error_page 404 /404.html;\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 8080
