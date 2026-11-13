// The machine behind the shell: the figures a visitor can ask for in more
// than one way (the login banner, `free`, `df`, `uptime`, `ps`, /proc) all
// come from here, so they agree with each other.
//
// host is what terminal.js knows before the shell exists - the names on the
// login banner and the numbers it prints in the MOTD:
//   { user, hostname, os: { name, version }, kernel,
//     stats: { load, memoryPercent, diskPercent, diskGb, processes, address, bootedAt } }

var DAY = 86400000;
var KERNEL_BUILD = "#15-Dubuntu SMP PREEMPT_DYNAMIC Fri Mar 20 10:14:32 UTC 2026";
var MEMORY_KB = 4005908;
var CORES = 2;

// Kernel threads, in the order a kernel of this vintage starts them. They
// are most of what `ps` shows on an idle server.
var KERNEL_THREADS = [
  "kthreadd", "pool_workqueue_release", "kworker/R-rcu_gp", "kworker/R-sync_wq",
  "kworker/R-slub_flushwq", "kworker/R-netns", "kworker/0:0H-events_highpri",
  "kworker/R-mm_percpu_wq", "rcu_tasks_kthread", "rcu_tasks_rude_kthread",
  "rcu_tasks_trace_kthread", "ksoftirqd/0", "rcu_preempt", "rcu_exp_par_gp_kthread_worker/0",
  "rcu_exp_gp_kthread_worker", "migration/0", "idle_inject/0", "cpuhp/0", "cpuhp/1",
  "idle_inject/1", "migration/1", "ksoftirqd/1", "kworker/1:0H-events_highpri", "kdevtmpfs",
  "kworker/R-inet_frag_wq", "kauditd", "khungtaskd", "oom_reaper", "kworker/R-writeback",
  "kcompactd0", "ksmd", "khugepaged", "kworker/R-kintegrityd", "kworker/R-kblockd",
  "kworker/R-blkcg_punt_bio", "irq/9-acpi", "kworker/R-tpm_dev_wq", "kworker/R-ata_sff",
  "kworker/R-md", "kworker/R-md_bitmap", "kworker/R-edac-poller", "kworker/R-devfreq_wq",
  "watchdogd", "kworker/0:1H-kblockd", "kswapd0", "ecryptfs-kthread", "kworker/R-kthrotld",
  "kworker/R-acpi_thermal_pm", "scsi_eh_0", "kworker/R-scsi_tmf_0", "scsi_eh_1",
  "kworker/R-scsi_tmf_1", "kworker/R-mld", "kworker/R-ipv6_addrconf", "kworker/R-kstrp",
  "kworker/u9:0", "kworker/R-charger_manager", "jbd2/vda1-8", "kworker/R-ext4-rsv-conversion",
  "kworker/1:1H-kblockd", "kworker/R-kmpath_rdacd", "kworker/R-kmpathd",
  "kworker/R-kmpath_handlerd", "psimon", "kworker/R-cryptd",
];

// The services of a stock server install: [user, command, resident KB, virtual KB, state].
var SERVICES = [
  ["root", "/usr/lib/systemd/systemd-journald", 17408, 66820, "S<s"],
  ["root", "/sbin/multipathd -d -s", 27136, 288876, "SLsl"],
  ["root", "/usr/lib/systemd/systemd-udevd", 7936, 28960, "Ss"],
  ["systemd+", "/usr/lib/systemd/systemd-networkd", 9472, 18980, "Ss"],
  ["systemd+", "/usr/lib/systemd/systemd-resolved", 12672, 21588, "Ss"],
  ["systemd+", "/usr/lib/systemd/systemd-timesyncd", 7424, 91024, "Ssl"],
  ["message+", "@dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only", 5120, 9660, "Ss"],
  ["polkitd", "/usr/lib/polkit-1/polkitd --no-debug", 7936, 308160, "Ssl"],
  ["root", "/usr/lib/systemd/systemd-logind", 8192, 18128, "Ss"],
  ["root", "/usr/libexec/udisks2/udisksd", 12928, 468988, "Ssl"],
  ["syslog", "/usr/sbin/rsyslogd -n -iNONE", 6144, 222508, "Ssl"],
  ["root", "/usr/sbin/cron -f -P", 2816, 6824, "Ss"],
  ["root", "/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal", 22272, 109660, "Ssl"],
  ["root", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", 7936, 12020, "Ss"],
  ["root", "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", 2176, 11156, "Ss"],
  ["www-data", "nginx: worker process", 4864, 12880, "S"],
  ["www-data", "nginx: worker process", 4864, 12880, "S"],
];

export function createMachine(host) {
  var stats = host.stats;
  var bootedAt = stats.bootedAt;
  var loggedInAt = Date.now();
  var release = host.os.version.split(" ")[0].split(".").slice(0, 2).join(".");

  var memory = { total: MEMORY_KB, shared: 1124 };
  memory.used = Math.round((MEMORY_KB * stats.memoryPercent) / 100);
  memory.cache = Math.round(MEMORY_KB * 0.31);
  memory.free = memory.total - memory.used - memory.cache;
  memory.available = memory.total - memory.used;

  var diskKb = Math.round(stats.diskGb * 1048576);
  var diskUsedKb = Math.round((diskKb * stats.diskPercent) / 100);
  // [device, 1K blocks, used, mount point]
  var filesystems = [
    ["tmpfs", Math.round(MEMORY_KB / 10), 1124, "/run"],
    ["/dev/vda1", diskKb, diskUsedKb, "/"],
    ["tmpfs", Math.round(MEMORY_KB / 2), 0, "/dev/shm"],
    ["tmpfs", 5120, 0, "/run/lock"],
    ["/dev/vda16", 901520, 62380, "/boot"],
    ["/dev/vda15", 106832, 6250, "/boot/efi"],
    ["tmpfs", Math.round(MEMORY_KB / 10), 12, "/run/user/0"],
  ];

  // The 5 and 15 minute averages trail the 1 minute one the banner shows.
  var load = [stats.load, stats.load * 0.84 + 0.01, stats.load * 0.62 + 0.02];

  function uptimeSeconds() {
    return Math.floor((Date.now() - bootedAt) / 1000);
  }

  // Everything running, fixed for the session, and as many as the login
  // banner counted: the kernel's threads, the services, then this login.
  // Each is { pid, ppid, user, tty, state, rss, vsz, command, kernel, started }.
  function buildProcesses(shellPid) {
    var list = [];
    function add(pid, ppid, user, command, rss, vsz, state, extra) {
      list.push(
        Object.assign(
          { pid: pid, ppid: ppid, user: user, tty: "?", state: state, rss: rss, vsz: vsz, command: command, started: bootedAt },
          extra
        )
      );
    }
    add(1, 0, "root", "/sbin/init", 13312, 22560, "Ss");
    // init, the services, the four processes of this login, and the `ps`
    // that is doing the counting; kernel threads make up the rest.
    var threads = Math.max(KERNEL_THREADS.length, stats.processes - SERVICES.length - 6);
    var pid = 2;
    for (var i = 0; i < threads; i++) {
      var name = KERNEL_THREADS[i] || "kworker/" + (i % CORES) + ":" + (i - KERNEL_THREADS.length + 2) + "-events";
      var state = /^kworker\/(R-|\d+:\d+H)/.test(name) ? "I<" : /^(kworker|rcu_)/.test(name) ? "I" : /^(ksmd|khugepaged)$/.test(name) ? "SN" : "S";
      add(pid, i ? 2 : 0, "root", name, 0, 0, state, { kernel: true });
      pid += i < 40 ? 1 : 1 + (i % 3);
    }
    pid = Math.max(pid + 180, 420);
    var master = 1;
    SERVICES.forEach(function (service, n) {
      var worker = service[1] === "nginx: worker process";
      add(pid, worker ? master : 1, service[0], service[1], service[2], service[3], service[4]);
      if (/^nginx: master/.test(service[1])) master = pid;
      pid += worker || master === pid ? 1 : 7 + ((n * 13) % 29);
    });
    var login = shellPid - 31;
    add(login, 1, "root", "/bin/login -p --", 5632, 9104, "Ss", { tty: "tty1" });
    add(login + 9, 1, "root", "/usr/lib/systemd/systemd --user", 11136, 20752, "Ss", { started: loggedInAt });
    add(login + 10, login + 9, "root", "(sd-pam)", 3692, 21336, "S", { started: loggedInAt });
    add(shellPid, login, "root", "-bash", 5376, 8656, "Ss", { tty: "tty1", started: loggedInAt, shell: true });
    return list;
  }

  var files = {
    "/etc/hostname": host.hostname + "\n",
    "/etc/hosts":
      "127.0.0.1 localhost\n127.0.1.1 " + host.hostname + "\n\n" +
      "# The following lines are desirable for IPv6 capable hosts\n" +
      "::1     ip6-localhost ip6-loopback\nfe00::0 ip6-localnet\nff00::0 ip6-mcastprefix\n" +
      "ff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n",
    "/etc/os-release":
      'PRETTY_NAME="' + host.os.name + " " + host.os.version + '"\n' +
      'NAME="' + host.os.name + '"\n' +
      'VERSION_ID="' + release + '"\n' +
      'VERSION="' + host.os.version + '"\n' +
      "ID=" + host.os.name.toLowerCase() + "\n" +
      'ID_LIKE="ubuntu debian"\n' +
      'HOME_URL="https://dubsector.dev/"\n',
    "/etc/lsb-release":
      "DISTRIB_ID=" + host.os.name + "\nDISTRIB_RELEASE=" + release + "\n" +
      'DISTRIB_DESCRIPTION="' + host.os.name + " " + host.os.version + '"\n',
    "/etc/issue": host.os.name + " " + host.os.version + " \\n \\l\n\n",
    "/etc/timezone": "Etc/UTC\n",
    "/etc/shells": "# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/rbash\n/usr/bin/dash\n",
    "/etc/resolv.conf": "nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n",
    "/etc/fstab":
      "LABEL=cloudimg-rootfs\t/\t ext4\tdiscard,commit=30,errors=remount-ro\t0 1\n" +
      "LABEL=BOOT\t/boot\text4\tdefaults\t0 2\n" +
      "LABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n",
    "/etc/passwd":
      "root:x:0:0:root:/root:/bin/bash\n" +
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
      "bin:x:2:2:bin:/bin:/usr/sbin/nologin\n" +
      "sys:x:3:3:sys:/dev:/usr/sbin/nologin\n" +
      "sync:x:4:65534:sync:/bin:/bin/sync\n" +
      "games:x:5:60:games:/usr/games:/usr/sbin/nologin\n" +
      "man:x:6:12:man:/var/cache/man:/usr/sbin/nologin\n" +
      "lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin\n" +
      "mail:x:8:8:mail:/var/mail:/usr/sbin/nologin\n" +
      "news:x:9:9:news:/var/spool/news:/usr/sbin/nologin\n" +
      "uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin\n" +
      "proxy:x:13:13:proxy:/bin:/usr/sbin/nologin\n" +
      "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n" +
      "backup:x:34:34:backup:/var/backups:/usr/sbin/nologin\n" +
      "list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin\n" +
      "irc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin\n" +
      "_apt:x:42:65534::/nonexistent:/usr/sbin/nologin\n" +
      "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n" +
      "systemd-network:x:998:998:systemd Network Management:/:/usr/sbin/nologin\n" +
      "systemd-timesync:x:996:996:systemd Time Synchronization:/:/usr/sbin/nologin\n" +
      "messagebus:x:101:101::/nonexistent:/usr/sbin/nologin\n" +
      "systemd-resolve:x:992:992:systemd Resolver:/:/usr/sbin/nologin\n" +
      "syslog:x:102:102::/nonexistent:/usr/sbin/nologin\n" +
      "polkitd:x:991:991:User for polkitd:/:/usr/sbin/nologin\n" +
      "sshd:x:103:65534::/run/sshd:/usr/sbin/nologin\n",
    "/etc/group":
      "root:x:0:\ndaemon:x:1:\nbin:x:2:\nsys:x:3:\nadm:x:4:syslog\ntty:x:5:\ndisk:x:6:\nlp:x:7:\n" +
      "mail:x:8:\nnews:x:9:\nuucp:x:10:\nman:x:12:\nproxy:x:13:\nkmem:x:15:\ndialout:x:20:\n" +
      "sudo:x:27:\nwww-data:x:33:\nbackup:x:34:\nshadow:x:42:\nutmp:x:43:\nusers:x:100:\n" +
      "messagebus:x:101:\nsyslog:x:102:\nnogroup:x:65534:\n",
    "/root/.profile":
      "# ~/.profile: executed by Bourne-compatible login shells.\n\n" +
      'if [ "$BASH" ]; then\n  if [ -f ~/.bashrc ]; then\n    . ~/.bashrc\n  fi\nfi\n\nmesg n 2> /dev/null || true\n',
    "/root/.bashrc":
      "# ~/.bashrc: executed by bash(1) for non-login shells.\n\n" +
      "# some more ls aliases\n" +
      "alias ll='ls -alF'\nalias la='ls -A'\nalias l='ls -CF'\n",
    "/proc/version":
      "Linux version " + host.kernel + " (buildd@lcy02-amd64-072) (x86_64-linux-gnu-gcc-15 (Ubuntu 15.2.0-4ubuntu4) 15.2.0, " +
      "GNU ld (GNU Binutils for Ubuntu) 2.45) " + KERNEL_BUILD + "\n",
    "/proc/cpuinfo": cpuinfo(),
    "/proc/meminfo": meminfo(memory),
  };

  // Files whose contents move with the clock; written again before every
  // command.
  function liveFiles(processCount, lastPid) {
    var up = (Date.now() - bootedAt) / 1000;
    return {
      "/proc/uptime": up.toFixed(2) + " " + (up * CORES * 0.985).toFixed(2) + "\n",
      "/proc/loadavg":
        load.map(function (n) {
          return n.toFixed(2);
        }).join(" ") + " 1/" + processCount + " " + lastPid + "\n",
    };
  }

  return {
    host: host,
    kernelBuild: KERNEL_BUILD,
    cores: CORES,
    release: release,
    memory: memory,
    filesystems: filesystems,
    load: load,
    bootedAt: bootedAt,
    loggedInAt: loggedInAt,
    // Installed a few months before it last booted; the site is newer.
    installedAt: bootedAt - 97 * DAY,
    deployedAt: bootedAt - 6 * DAY,
    uptimeSeconds: uptimeSeconds,
    buildProcesses: buildProcesses,
    files: files,
    liveFiles: liveFiles,
    // Directories a real install has that nothing above creates.
    directories: [
      "/boot/efi", "/dev/shm", "/home", "/lost+found", "/media", "/mnt", "/opt", "/run/lock", "/run/user/0",
      "/sbin", "/srv", "/sys", "/tmp", "/usr/local/bin", "/usr/sbin", "/var/log", "/var/mail", "/var/tmp",
    ],
    // Directories that aren't the usual rwxr-xr-x.
    modes: { "/root": 448, "/lost+found": 448, "/tmp": 1023, "/var/tmp": 1023, "/dev/shm": 1023, "/proc": 365, "/sys": 365 },
    // Trees that are made afresh at every boot.
    volatile: ["/dev", "/proc", "/run", "/sys", "/tmp"],
  };
}

function cpuinfo() {
  var out = "";
  for (var i = 0; i < CORES; i++) {
    out +=
      "processor\t: " + i + "\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 85\n" +
      "model name\t: Intel Xeon Processor (Skylake, IBRS)\nstepping\t: 4\nmicrocode\t: 0x1\n" +
      "cpu MHz\t\t: 2294.608\ncache size\t: 16384 KB\nphysical id\t: 0\nsiblings\t: " + CORES + "\n" +
      "core id\t\t: " + i + "\ncpu cores\t: " + CORES + "\napicid\t\t: " + i + "\nfpu\t\t: yes\n" +
      "bogomips\t: 4589.21\nclflush size\t: 64\ncache_alignment\t: 64\n" +
      "address sizes\t: 40 bits physical, 48 bits virtual\n\n";
  }
  return out;
}

function meminfo(memory) {
  function row(name, kb) {
    return (name + ":").padEnd(16) + String(kb).padStart(8) + " kB\n";
  }
  return (
    row("MemTotal", memory.total) +
    row("MemFree", memory.free) +
    row("MemAvailable", memory.available) +
    row("Buffers", Math.round(memory.cache * 0.07)) +
    row("Cached", Math.round(memory.cache * 0.86)) +
    row("SwapCached", 0) +
    row("SwapTotal", 0) +
    row("SwapFree", 0) +
    row("Shmem", memory.shared)
  );
}
