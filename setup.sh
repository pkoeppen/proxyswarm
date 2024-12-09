#!/bin/bash

for var in PROXY_USERNAME PROXY_PASSWORD; do
  if [ -z "${!var}" ]; then
		echo "Error: $var is not set." >&2
		exit 1
	fi
done

setup_docker() {
	# This setup has been copied from the official Docker setup guide for Debian.
	# https://docs.docker.com/engine/install/debian/

	for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do sudo apt-get remove $pkg; done

	# Add Docker's official GPG key.
	sudo apt-get update
	sudo apt-get install -y ca-certificates curl
	sudo install -m 0755 -d /etc/apt/keyrings
	sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	sudo chmod a+r /etc/apt/keyrings/docker.asc

	# Add the repository to Apt sources.
	echo \
	  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
	  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
	  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
	sudo apt-get update

	# Install the Docker packages.
	sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

setup_docker

docker run --name proxy -d --restart=always -p 8081:3128 \
	--env USERNAME=$PROXY_USERNAME \
	--env PASSWORD=$PROXY_PASSWORD \
	yegor256/squid-proxy

echo "Success"
