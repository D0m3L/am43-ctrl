docker run -d \
  --name rolety \
  --platform linux/arm/v7 \
  --net=host \
  --privileged \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  -v /var/run/dbus:/var/run/dbus \
  --restart=unless-stopped \
  -e DEBUG="am43:*" \
  -e MAC1="02:73:f4:0a:2a:a1" \
  -e MAC2="02:51:eb:6e:37:ca" \
  -e URL="mqtt://192.168.0.101" \
  -e PORT="5001" \
  -e TIMEO="1200" \
  rolety:latest
