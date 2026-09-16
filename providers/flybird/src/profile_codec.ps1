# Client protocol constants are shared by installations, not account credentials.
$FlyingBirdConfigSecret = "fd53c838dbceff962d5d2aed5cdc548e"

function Convert-Base64TextToBytes {
    param([string]$Text)
    $normalized = ($Text -replace '\s+', '').Replace('-', '+').Replace('_', '/')
    $padding = $normalized.Length % 4
    if ($padding -gt 0) { $normalized += ('=' * (4 - $padding)) }
    return ,([Convert]::FromBase64String($normalized))
}

function Unprotect-FlyingBirdGcm {
    param([byte[]]$Envelope)
    if ($Envelope.Length -lt 28) { throw "Invalid GCM envelope" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($FlyingBirdConfigSecret)) }
    finally { $sha.Dispose() }
    $nonce = New-Object byte[] 12
    $tag = New-Object byte[] 16
    $ciphertext = New-Object byte[] ($Envelope.Length - 28)
    $plain = New-Object byte[] $ciphertext.Length
    [Array]::Copy($Envelope, 0, $nonce, 0, 12)
    [Array]::Copy($Envelope, 12, $ciphertext, 0, $ciphertext.Length)
    [Array]::Copy($Envelope, $Envelope.Length - 16, $tag, 0, 16)
    try {
        if ("System.Security.Cryptography.AesGcm" -as [type]) {
            $gcm = New-Object System.Security.Cryptography.AesGcm -ArgumentList @(,$key)
            try { $gcm.Decrypt($nonce, $ciphertext, $tag, $plain, $null) }
            finally { $gcm.Dispose() }
        }
        else {
            # Windows PowerShell 5.1 has no managed AesGcm. Use Windows CNG;
            # authentication and AES remain in the operating system crypto API.
            if (-not ("FlyingBirdProfile.NativeGcm" -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
namespace FlyingBirdProfile {
    public static class NativeGcm {
        [StructLayout(LayoutKind.Sequential)]
        private struct AuthInfo {
            public int Size, Version;
            public IntPtr Nonce;
            public int NonceLength;
            public IntPtr AuthData;
            public int AuthDataLength;
            public IntPtr Tag;
            public int TagLength;
            public IntPtr MacContext;
            public int MacContextLength, AadLength;
            public ulong DataLength;
            public int Flags;
        }
        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int BCryptOpenAlgorithmProvider(out IntPtr handle, string algorithm, string provider, int flags);
        [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
        private static extern int BCryptSetProperty(IntPtr handle, string property, byte[] value, int length, int flags);
        [DllImport("bcrypt.dll")]
        private static extern int BCryptGenerateSymmetricKey(IntPtr algorithm, out IntPtr key, IntPtr keyObject, int keyObjectLength, byte[] secret, int secretLength, int flags);
        [DllImport("bcrypt.dll")]
        private static extern int BCryptDecrypt(IntPtr key, byte[] input, int inputLength, ref AuthInfo auth, IntPtr iv, int ivLength, byte[] output, int outputLength, out int resultLength, int flags);
        [DllImport("bcrypt.dll")]
        private static extern int BCryptDestroyKey(IntPtr key);
        [DllImport("bcrypt.dll")]
        private static extern int BCryptCloseAlgorithmProvider(IntPtr algorithm, int flags);
        private static void Check(int status) {
            if (status != 0) throw new CryptographicException("GCM authentication or decoding failed");
        }
        public static byte[] Decrypt(byte[] secret, byte[] nonce, byte[] ciphertext, byte[] tag) {
            IntPtr algorithm = IntPtr.Zero, key = IntPtr.Zero;
            GCHandle nonceHandle = default(GCHandle), tagHandle = default(GCHandle);
            byte[] plaintext = new byte[ciphertext.Length];
            bool authenticated = false;
            try {
                Check(BCryptOpenAlgorithmProvider(out algorithm, "AES", null, 0));
                byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
                Check(BCryptSetProperty(algorithm, "ChainingMode", mode, mode.Length, 0));
                Check(BCryptGenerateSymmetricKey(algorithm, out key, IntPtr.Zero, 0, secret, secret.Length, 0));
                nonceHandle = GCHandle.Alloc(nonce, GCHandleType.Pinned);
                tagHandle = GCHandle.Alloc(tag, GCHandleType.Pinned);
                AuthInfo auth = new AuthInfo {
                    Size = Marshal.SizeOf(typeof(AuthInfo)), Version = 1,
                    Nonce = nonceHandle.AddrOfPinnedObject(), NonceLength = nonce.Length,
                    Tag = tagHandle.AddrOfPinnedObject(), TagLength = tag.Length
                };
                int written;
                Check(BCryptDecrypt(key, ciphertext, ciphertext.Length, ref auth, IntPtr.Zero, 0, plaintext, plaintext.Length, out written, 0));
                if (written != plaintext.Length) throw new CryptographicException("Invalid GCM output length");
                authenticated = true;
                return plaintext;
            } finally {
                if (!authenticated) Array.Clear(plaintext, 0, plaintext.Length);
                if (tagHandle.IsAllocated) tagHandle.Free();
                if (nonceHandle.IsAllocated) nonceHandle.Free();
                if (key != IntPtr.Zero) BCryptDestroyKey(key);
                if (algorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(algorithm, 0);
            }
        }
    }
}
'@
            }
            $plain = [FlyingBirdProfile.NativeGcm]::Decrypt($key, $nonce, $ciphertext, $tag)
        }
        return ,$plain
    }
    finally { [Array]::Clear($key, 0, $key.Length) }
}

function Decrypt-FlyingBirdPreference {
    param([string]$Value)
    if (-not $Value.StartsWith("enc1:")) { return $Value }
    try {
        $plain = Unprotect-FlyingBirdGcm (Convert-Base64TextToBytes $Value.Substring(5))
        return [Text.Encoding]::UTF8.GetString($plain)
    }
    catch { throw "Cannot authenticate FlyingBird preference" }
}

function Decrypt-FlyingBirdProfile {
    param([string]$CipherText)
    try { $outer = Convert-Base64TextToBytes $CipherText }
    catch { throw "Cannot authenticate or decode FlyingBird subscription" }
    try {
        $plain = Unprotect-FlyingBirdGcm $outer
        $yaml = [Text.Encoding]::UTF8.GetString($plain)
        if ($yaml -match '(?m)^\s*proxies:\s*$') { return $yaml }
    }
    catch { }

    # Legacy clients wrap either YAML or Base64(YAML) in AES-128-CBC.
    if ($outer.Length -gt 0 -and $outer.Length % 16 -eq 0) {
        $aes = [Security.Cryptography.Aes]::Create()
        $decryptor = $null
        try {
            $aes.Mode = [Security.Cryptography.CipherMode]::CBC
            $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
            $aes.Key = [Text.Encoding]::ASCII.GetBytes("14f521a32997b257")
            $aes.IV = [Text.Encoding]::ASCII.GetBytes("d217125f4b9cc9c8")
            $decryptor = $aes.CreateDecryptor()
            $inner = [Text.Encoding]::UTF8.GetString($decryptor.TransformFinalBlock($outer, 0, $outer.Length)).Trim()
            if ($inner -match '(?m)^\s*proxies:\s*$') { return $inner }
            $yaml = [Text.Encoding]::UTF8.GetString((Convert-Base64TextToBytes $inner))
            if ($yaml -match '(?m)^\s*proxies:\s*$') { return $yaml }
        }
        catch { }
        finally {
            if ($decryptor) { $decryptor.Dispose() }
            $aes.Dispose()
        }
    }
    throw "Cannot authenticate or decode FlyingBird subscription"
}
