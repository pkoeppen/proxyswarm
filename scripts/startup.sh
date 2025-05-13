#!/bin/bash
# TODO: set PROXY_USERNAME and PROXY_PASSWORD elsewhere
curl -fsSL https://raw.githubusercontent.com/pkoeppen/proxyswarm/master/setup.sh |\
  		PROXY_USERNAME=username PROXY_PASSWORD=password sudo -E bash