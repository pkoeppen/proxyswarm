#!/bin/bash

PROXY_USERNAME=username
PROXY_PASSWORD=password
PROXY_FILE=".proxies"

start_proxy() {
	PROXY_HOST=$1
	echo "Starting proxy on $PROXY_HOST"
	ssh -i ~/.ssh/id_proxyswarm root@$PROXY_HOST -o StrictHostKeyChecking=no \
  		"curl -fsSL https://raw.githubusercontent.com/pkoeppen/proxyswarm/master/setup.sh |\
  		PROXY_USERNAME=$PROXY_USERNAME PROXY_PASSWORD=$PROXY_PASSWORD sudo -E bash"
}

process_many() {
	if [ ! -f "$PROXY_FILE" ]; then
		echo "Error: $PROXY_FILE file not found."
		exit 1
	fi

	while IFS= read -r PROXY_HOST; do
		start_proxy $PROXY_HOST
	done < "$PROXY_FILE"
}

if [ -z "$1" ]; then
  process_many
else
  start_proxy $1
fi
