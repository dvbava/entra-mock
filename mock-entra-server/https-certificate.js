import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function hasValidCertificate(certPath, keyPath) {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return false;

  const certBytes = fs.readFileSync(certPath);
  const keyBytes = fs.readFileSync(keyPath);

  try {
    const cert = new crypto.X509Certificate(certBytes);
    const key = crypto.createPrivateKey(keyBytes);
    const certPublicKey = cert.publicKey.export({ format: 'der', type: 'spki' });
    const keyPublicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
    return certPublicKey.equals(keyPublicKey);
  } catch {
    return false;
  }
}

function runPowerShell(script, environment) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  });
}

function generateCertificate(certPath, keyPath) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'

Write-Host "Generating localhost certificate..."

$cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(1)

$nl = [Environment]::NewLine
$certPath = $env:ENTRA_MOCK_CERT_PATH
$keyPath = $env:ENTRA_MOCK_KEY_PATH

$certBytes = $cert.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
)

$certBase64 = [Convert]::ToBase64String(
    $certBytes,
    [Base64FormattingOptions]::InsertLineBreaks
)

$certPem = "-----BEGIN CERTIFICATE-----" + $nl +
    $certBase64 + $nl +
    "-----END CERTIFICATE-----"

[System.IO.File]::WriteAllText($certPath, $certPem)

$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
$keyBytes = $rsa.Key.Export(
    [System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob
)

$keyBase64 = [Convert]::ToBase64String(
    $keyBytes,
    [Base64FormattingOptions]::InsertLineBreaks
)

$keyPem = "-----BEGIN PRIVATE KEY-----" + $nl +
    $keyBase64 + $nl +
    "-----END PRIVATE KEY-----"

[System.IO.File]::WriteAllText($keyPath, $keyPem)

$rsa.Dispose()

Write-Host "Certificate created successfully."
Write-Host "Certificate: $certPath"
Write-Host "Private key: $keyPath"
`;

  runPowerShell(script, {
    ENTRA_MOCK_CERT_PATH: certPath,
    ENTRA_MOCK_KEY_PATH: keyPath,
  });
}

function trustCertificate(certPath) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'

$certPem = [System.IO.File]::ReadAllText($env:ENTRA_MOCK_CERT_PATH)
$certBase64 = $certPem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s', ''
$certBytes = [Convert]::FromBase64String($certBase64)
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certBytes)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')

try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $trusted = $store.Certificates.Find(
        [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
        $cert.Thumbprint,
        $false
    )

    if ($trusted.Count -eq 0) {
        $store.Add($cert)
        Write-Host "Trusted localhost certificate installed in CurrentUser\Root."
    }
}
finally {
    $store.Close()
    $cert.Dispose()
}
`;

  runPowerShell(script, { ENTRA_MOCK_CERT_PATH: certPath });
}

export function ensureLocalCertificate(directory) {
  const certPath = path.join(directory, 'cert.pem');
  const keyPath = path.join(directory, 'key.pem');

  if (process.platform === 'win32' && !hasValidCertificate(certPath, keyPath)) {
    if (fs.existsSync(certPath) || fs.existsSync(keyPath)) {
      console.warn('Existing localhost certificate is invalid; regenerating it.');
    }
    generateCertificate(certPath, keyPath);
  }

  if (process.platform === 'win32') trustCertificate(certPath);

  return { certPath, keyPath };
}
