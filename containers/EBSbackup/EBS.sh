#!/bin/bash -x

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

function errorexit () {
    echo >&2 "$@"
    exit 1
}

function detachandexit () {
    aws ec2 detach-volume --volume-id $volumeid
    rm $devlockfile
    errorexit "$@"
}

retry() {
    local -r -i max_attempts="$1"; shift
    local -r cmd="$@"
    local -i attempt_num=1
    until $cmd
    do
        if ((attempt_num==max_attempts))
        then
            echo "Attempt $attempt_num failed and there are no more attempts left!"
            return 1
        else
            echo "Attempt $attempt_num failed! Trying again in $attempt_num seconds..."
            sleep $((attempt_num++))
        fi
    done
}

function getnextdev() {

    blkdev=""
    for l in {z..f}
    do  
        # Multiple processes could attempt to attach volumes at the same time.
        # There is a delay between the request to attach and the creation of the device file.
        # Create a lock file to avoid this race condition.
        devlockfile=${IROOT}/tmp/ebsdevlock.${l}
        if [ ! -f $devlockfile ]
        then
            touch $devlockfile
            if [ ! -b ${IROOT}/dev/xvd${l} ]
            then
                blkdev="/dev/xvd${l}"
                break
            fi
        fi
    done
    
    if [ "X$blkdev" = "X" ]
    then
        errorexit "No available block device files"
    fi
}

function getInstanceId () {
    instanceid=`ec2-metadata -i | cut -d\  -f2`
    echo $instanceid | grep -E -q '^i-[a-z0-9]{8,}$' || errorexit "Failed to get instanceid. Got $instanceid"
}

[ "$#" -eq 2 ] || errorexit "Expecting 2 arguments. Got $#"
volumeid=$1
echo $volumeid | grep -E -q '^vol-[a-z0-9]{8,}$' || errorexit "Invalid volumeid. Got $volumeid"
s3path=$2
echo $s3path | grep -E -q '^s3:\/\/[^\/[:space:]]*\/[^[:space:]]*$' || errorexit "Invalid S3 Path. Got $s3path"

getInstanceId

echo "Instance ID: $instanceid"
echo "Volume ID: $volumeid"
echo "S3 path: $s3path"

function attachvolume () {
    getnextdev
    echo "Blockdev: $blkdev"
    aws ec2 attach-volume --volume-id $volumeid --instance-id $instanceid --device $blkdev
}

retry 3 attachvolume
[ $? -eq 0 ] || detachandexit "Failed to attach $volumeid to $instanceid on $blkdev"

mntdir=`mktemp -d -p $IROOT/tmp`
[ $? -eq 0 ] || detachandexit "Failed to create temp mountpoint in $IROOT/mnt"

while read path event file
do
    if [ "$IROOT$blkdev" = "$path$file" ]
    then
        found=$IROOT$blkdev
        break
    elif [[ $file == nvme*n1 ]]
    then
        found=$path$file
        break
    fi
done < <(timeout 300 inotifywait -m $IROOT/dev -e close)
[ "$found" = "$IROOT$blkdev" ] || lsblk -o +SERIAL $found | grep ${volumeid:4} || detachandexit `aws ec2 describe-volumes --volume-ids $volumeid`

retry 5 mount $found $mntdir
if [ $? -eq 0 ]
then
    tar -cz -C $mntdir . | aws s3 cp - $s3path/backup.tar.gz || detachandexit "failed to backup to $s3path"
    umount $mntdir || detachandexit "failed to unmount"
else
    echo "Unable to mount filesystem. Dumping with dd."
    dd bs=10M if=$found | gzip | aws s3 cp - $s3path/rawbackup.gz || detachandexit "failed to backup to $s3path with dd"
fi

aws ec2 detach-volume --volume-id $volumeid
rm $devlockfile
