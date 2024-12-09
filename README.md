### To run:

```shell
export PROXY_USERNAME=your_username
export PROXY_PASSWORD=your_password
ssh -i ~/.ssh/id_proxyswarm root@ip_address "\
  curl -fsSL https://raw.githubusercontent.com/pkoeppen/proxyswarm/master/setup.sh |\
  PROXY_USERNAME=$PROXY_USERNAME PROXY_PASSWORD=$PROXY_PASSWORD sudo -E bash"
```

### To test:

```shell
curl -fsSL -vvv --proxy your_proxy_host -U username:password https://httpbin.org/ip
```

TODO: Add proxy for-loop with health checks; determine whether proxy already running
