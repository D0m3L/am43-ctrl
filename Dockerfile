FROM --platform=linux/arm/v7 node:14.15.1-alpine
ENV LANG=C.UTF-8
ENV NODE_ENV=production
ENV URL="mqtt://192.168.0.101"
ENV MAC1="02:73:f4:0a:2a:a1"
ENV MAC2="02:51:eb:6e:37:ca"
ENV TIMEO=600
ENV MQTTUSER="mqtt"
ENV PORT="5001"
ENV MQTTPWD="mqttpass"
WORKDIR /app/rolety
RUN apk add --no-cache git python3 make g++ gcc linux-headers eudev-dev libusb-dev bash nano
RUN echo '{"name":"rolety","version":"1.0.0","overrides":{"@abandonware/noble":"1.9.2-14","@abandonware/bluetooth-hci-socket":"0.5.3-7","node-gyp":"^5.1.1"}}' > package.json
RUN npm install node-pre-gyp@^0.17.0 \
  && npm install @abandonware/bluetooth-hci-socket@0.5.3-7 \
  && npm install @abandonware/noble@1.9.2-14 \
  && npm install https://github.com/binsentsu/am43-ctrl --legacy-peer-deps
WORKDIR /app/rolety/node_modules/.bin
ENTRYPOINT ["/bin/sh", "-c", "./am43ctrl ${MAC1} ${MAC2} -d --url ${URL} -l ${PORT} -f ${TIMEO}"]
