# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

FROM public.ecr.aws/amazonlinux/amazonlinux:2

RUN yum install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm

RUN yum update -y \
  && yum install -y \
  ec2-utils \
  inotify-tools \
  python-pip \
  tar \
  util-linux \
  && yum clean all \
  && pip --no-cache-dir install --upgrade awscli
  
COPY EBS.sh /usr/local/bin

ENTRYPOINT ["/usr/local/bin/EBS.sh"]