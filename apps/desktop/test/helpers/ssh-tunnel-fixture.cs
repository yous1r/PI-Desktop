using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;

public static class SshTunnelFixture
{
    public static int Main(string[] args)
    {
        string executable = typeof(SshTunnelFixture).Assembly.Location;
        int forwardIndex = Array.IndexOf(args, "-L");
        if (forwardIndex < 0)
        {
            string script = Console.In.ReadToEnd();
            File.WriteAllText(executable + ".exec.txt", Process.GetCurrentProcess().Id + "\n" + script);
            Console.WriteLine("PI_HOST_READY {\"hostId\":\"fixture-host\",\"host\":\"127.0.0.1\",\"port\":4321,\"version\":\"0.22.3\"}");
            return 0;
        }
        string[] binding = args[forwardIndex + 1].Split(':');
        var listener = new TcpListener(IPAddress.Loopback, int.Parse(binding[1]));
        File.WriteAllText(executable + ".forward.txt", Process.GetCurrentProcess().Id + "\n" + string.Join("\n", args));
        listener.Start();
        for (;;)
        {
            using (var client = listener.AcceptTcpClient()) { }
        }
    }
}
