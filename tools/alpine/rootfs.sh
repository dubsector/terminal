#!/usr/bin/env bash
# Builds the root filesystem of the Linux machine that `reboot` starts in
# the browser: Alpine Linux for 32-bit x86, which is what v86 emulates.
#
#     sudo tools/alpine/rootfs.sh <work dir> <out.tar>
#
# Needs root on x86-64 Linux, because the packages are installed by running
# Alpine's own `apk` inside the new root (a chroot). GitHub's runners and WSL
# both do. Nothing outside the work directory is touched. pack.mjs turns the
# tar this writes into the image the site serves.
set -euo pipefail

ALPINE=3.24.4
MINIROOTFS_SHA256=df793865bf166c10acaad3a4d5d40498f9ee3f89fa405d39c7f540464fb3b0c1
# bash is the login shell; the rest is what someone poking around expects to
# find. v86 fetches a file only when the guest opens it, so a package costs
# nothing at boot unless boot uses it. The machine has no network (a page
# can't send raw packets, and relaying them would make the site a proxy), so
# nothing that needs one is installed.
PACKAGES="bash nano less htop tree file ncurses-terminfo-base"

here=$(cd "$(dirname "$0")" && pwd)
work=$(mkdir -p "$1" && cd "$1" && pwd)
out=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
root=$work/rootfs

tarball=alpine-minirootfs-$ALPINE-x86.tar.gz
[ -f "$work/$tarball" ] || curl -fsSL -o "$work/$tarball" \
  "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE%.*}/releases/x86/$tarball"
echo "$MINIROOTFS_SHA256  $work/$tarball" | sha256sum -c -

unmount() {
  for dir in proc dev; do
    mountpoint -q "$root/$dir" && umount -l "$root/$dir"
  done
  return 0
}
[ -d "$root" ] && unmount
rm -rf "$root"
mkdir "$root"
tar -xzf "$work/$tarball" -C "$root"

cp /etc/resolv.conf "$root/etc/resolv.conf"
cp "$here/init" "$root/tmp/init"
mount -t proc none "$root/proc"
mount --bind /dev "$root/dev"
trap unmount EXIT

chroot "$root" /bin/sh -euc "
  apk add --no-cache openrc alpine-base agetty linux-virt linux-firmware-none $PACKAGES

  # A login prompt on the serial port, which is the only console there is.
  # Alpine's agetty shows no issue file unless it is named.
  sed -i '/^tty[0-9]/d; /^#ttyS0/d' /etc/inittab
  echo 'ttyS0::respawn:/sbin/agetty -L -f /etc/issue 115200 ttyS0 vt220' >> /etc/inittab
  passwd -d root
  sed -i 's|^root:\(.*\):/bin/sh\$|root:\1:/bin/bash|' /etc/passwd
  echo websvr > /etc/hostname

  # The services a machine with no real hardware needs, and no others:
  # probing for devices takes most of a minute under emulation and finds
  # nothing.
  for service in devfs dmesg; do rc-update add \$service sysinit; done
  for service in hwclock modules sysctl hostname syslog bootmisc; do rc-update add \$service boot; done
  rc-update add killprocs shutdown

  # An initramfs holding only what it takes to mount the root over 9p.
  printf '%s\n' /bin/busybox /bin/sh /sbin/modprobe '/etc/modprobe.d/*.conf' > /etc/mkinitfs/features.d/v86.files
  printf '%s\n' kernel/net/9p kernel/fs/9p kernel/fs/netfs kernel/drivers/virtio > /etc/mkinitfs/features.d/v86.modules
  mkinitfs -i /tmp/init -F v86 \$(cat /usr/share/kernel/virt/kernel.release)
  cat /usr/share/kernel/virt/kernel.release > /boot/kernel.release
"
rm "$root/tmp/init" "$root/etc/resolv.conf"
unmount
trap - EXIT

# Files of our own, laid over the install. Modes are set here rather than
# copied: a checkout on Windows has none worth keeping.
(cd "$here/rootfs" && find . -type f) | while read -r file; do
  install -D -m 644 "$here/rootfs/$file" "$root/$file"
done

# The site's own folder is left empty: src/linux.js fills it from
# src/shell/links.json as the machine starts, so links change without a new
# image.
mkdir -p "$root/var/www/dubsector.dev"

# Member names without a leading "./", which v86's tools would otherwise
# take for a directory called ".".
(cd "$root" && tar --numeric-owner -cf "$out" -- *)
echo "$(du -sh "$root" | cut -f1) in $(find "$root" -xdev -type f | wc -l) files -> $out"
