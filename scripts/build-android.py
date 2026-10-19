"""Build the native Android WebView app using an installed JDK and Android SDK."""
import os
import pathlib
import shutil
import subprocess
import zipfile
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parent.parent
sdk = pathlib.Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or '')
jdk = pathlib.Path(os.environ.get('JAVA_HOME', '')) / 'bin'
suffix = '.exe' if os.name == 'nt' else ''
platform = pathlib.Path(os.environ['STELLA_ANDROID_PLATFORM']) if os.environ.get('STELLA_ANDROID_PLATFORM') else sdk / 'platforms' / 'android-35' / 'android.jar'
choices = sorted((sdk / 'build-tools').glob('*'), key=lambda p: tuple(int(n) if n.isdigit() else 0 for n in p.name.split('.')))
if not platform.is_file() or not choices or not (jdk / ('javac' + suffix)).is_file():
    raise SystemExit('Set JAVA_HOME and ANDROID_HOME; install SDK Platform 35 and Build Tools 35.x.')
tools = pathlib.Path(os.environ['STELLA_BUILD_TOOLS']) if os.environ.get('STELLA_BUILD_TOOLS') else choices[-1]
out = root / 'build' / 'android'
out.mkdir(parents=True, exist_ok=True)
for directory in ['classes', 'dex', 'assets']:
    resolved = (out / directory).resolve()
    assert resolved.is_relative_to((root / 'build').resolve())
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir()
shutil.copytree(root / 'web', out / 'assets' / 'web')

def run(args):
    subprocess.run([str(arg) for arg in args], check=True)

run([tools / ('aapt2' + suffix), 'compile', '--dir', root / 'android' / 'res', '-o', out / 'resources.zip'])
run([tools / ('aapt2' + suffix), 'link', '-o', out / 'unsigned.apk', '-I', platform, '--manifest', root / 'android' / 'AndroidManifest.xml', '-A', out / 'assets', '--auto-add-overlay', out / 'resources.zip'])
run([jdk / ('javac' + suffix), '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', platform, '-d', out / 'classes', *sorted((root / 'android' / 'src').rglob('*.java'))])
with zipfile.ZipFile(out / 'classes.jar', 'w') as archive:
    for source in (out / 'classes').rglob('*.class'):
        archive.write(source, source.relative_to(out / 'classes').as_posix())
run([jdk / ('java' + suffix), '-cp', tools / 'lib' / 'd8.jar', 'com.android.tools.r8.D8', '--lib', platform, '--min-api', '26', '--output', out / 'dex', out / 'classes.jar'])
with zipfile.ZipFile(out / 'unsigned.apk', 'a') as archive:
    archive.write(out / 'dex' / 'classes.dex', 'classes.dex')
run([tools / ('zipalign' + suffix), '-f', '4', out / 'unsigned.apk', out / 'aligned.apk'])

key = pathlib.Path(os.environ['STELLA_KEYSTORE']) if os.environ.get('STELLA_KEYSTORE') else out / 'development.jks'
alias = os.environ.get('STELLA_KEY_ALIAS', 'stella-development')
if os.environ.get('STELLA_KEYSTORE'):
    if not key.is_file() or not os.environ.get('STELLA_STORE_PASSWORD'):
        raise SystemExit('Release builds require an existing STELLA_KEYSTORE and STELLA_STORE_PASSWORD.')
    password_env = 'STELLA_STORE_PASSWORD'
else:
    password_env = 'STELLA_DEVELOPMENT_PASSWORD'
    os.environ[password_env] = 'android-development-only'
    if not key.exists():
        run([jdk / ('keytool' + suffix), '-genkeypair', '-keystore', key, '-storepass:env', password_env, '-keypass:env', password_env, '-alias', alias, '-dname', 'CN=Stella Reader Development', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000'])
version = ET.parse(root / 'android' / 'AndroidManifest.xml').getroot().attrib['{http://schemas.android.com/apk/res/android}versionName']
apk = root / 'dist' / ('StellaReader-Android-' + version + '.apk')
apk.parent.mkdir(exist_ok=True)
run([jdk / ('java' + suffix), '-jar', tools / 'lib' / 'apksigner.jar', 'sign', '--ks', key, '--ks-key-alias', alias, '--ks-pass', 'env:' + password_env, '--key-pass', 'env:' + password_env, '--out', apk, out / 'aligned.apk'])
run([jdk / ('java' + suffix), '-jar', tools / 'lib' / 'apksigner.jar', 'verify', '--verbose', apk])
print('APK_READY', apk)
