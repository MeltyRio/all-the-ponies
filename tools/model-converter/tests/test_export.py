"""The public native path, independent GLBs and uploader-safe catalogue."""
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

from atp_glb import from_native, model_glb
from atp_glb.export import AssetBundle, convert_native, write_bundle
from atp_glb.native import NativeInputError, load_native
from tests.test_converter import unpack

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from native_fixture import write_fixture


def accessor(document, binary, index):
    item = document['accessors'][index]
    view = document['bufferViews'][item['bufferView']]
    dtype = {5126: '<f4', 5123: '<u2', 5125: '<u4'}[item['componentType']]
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[item['type']]
    value = np.frombuffer(binary, dtype=dtype, count=item['count'] * width, offset=view['byteOffset'])
    value = value.reshape(item['count'], width)
    if item['type'] == 'MAT4':
        value = value.reshape(-1, 4, 4).transpose(0, 2, 1)
    return value


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name) / 'native'
        write_fixture(self.folder)

    def tearDown(self):
        self.temp.cleanup()

    def load(self):
        return load_native(self.folder / 'flag.rk', self.folder / 'flag.anim', self.folder / 'flag.csv', ['wave'],
                           visible_meshes=['flag'], rest_name='rest', event_path=self.folder / 'flag.xml')

    def convert(self):
        return convert_native(self.folder / 'flag.rk', self.folder / 'flag.anim', self.folder / 'flag.csv', ['wave'],
                              identity='Synthetic_Flag', visible_meshes=['flag'], rest_name='rest',
                              event_path=self.folder / 'flag.xml')

    def test_native_two_joint_geometry_bind_uv_and_standalone_animation(self):
        native = self.load()
        model, clips = from_native(native, identity='Synthetic_Flag')
        bundle = self.convert()
        row = bundle.catalogue['models']['Synthetic_Flag']
        document, binary = unpack(bundle.files[row['path']])
        animation, _ = unpack(bundle.files[row['animations'][0]['path']])
        self.assertNotIn('animations', document)
        self.assertNotIn('meshes', animation)
        self.assertNotIn('images', animation)
        self.assertEqual(document['extras']['atpRig'], animation['extras']['atpRig'])
        self.assertEqual(row['rigKey'], document['extras']['atpRig']['key'])
        self.assertEqual(row['animations'][0]['duration'], 46 / 15)
        np.testing.assert_array_equal(native['bones'][1]['bind_global'], model.bind_global[1])
        np.testing.assert_array_equal(model.bind_global[1][:3, 3], [0, -1, 0])
        inv = accessor(document, binary, document['skins'][0]['inverseBindMatrices'])
        np.testing.assert_allclose(model.bind_global @ inv, np.broadcast_to(np.eye(4), (2, 4, 4)))
        attrs = document['meshes'][0]['primitives'][0]['attributes']
        np.testing.assert_array_equal(accessor(document, binary, attrs['TEXCOORD_0']), model.texcoords)
        triangles = accessor(document, binary, document['meshes'][0]['primitives'][0]['indices']).reshape(-1, 3)
        np.testing.assert_array_equal(triangles, native['primitives'][0]['indices'][:, [0, 2, 1]])
        # Matrix skinning for the upper flag tip must actually move while root remains fixed.
        point = np.r_[model.positions[-1], 1]
        posed = clips[0].global_frames[11, 1] @ inv[1] @ point
        self.assertGreater(abs(posed[0] - point[0]), .1)
        np.testing.assert_allclose(clips[0].global_frames[:, 0], np.broadcast_to(np.eye(4), (46, 4, 4)))

    def test_digest_assets_and_json_reserialization_are_independent(self):
        bundle = self.convert()
        for path, data in bundle.files.items():
            self.assertEqual(path, f'models/3d/{hashlib.sha256(data).hexdigest()}.glb')
        # Mirrors ATP data sync's semantic JSON load/dump; no JSON byte hash is referenced.
        rewritten = json.dumps(json.loads(json.dumps(bundle.catalogue, indent=2)), ensure_ascii=False, separators=(',', ':'))
        self.assertEqual(json.loads(rewritten), bundle.catalogue)
        self.assertNotIn(str(self.folder), rewritten)
        self.assertNotIn('provenance', rewritten)
        self.assertNotIn('http', rewritten)
        self.assertEqual(self.convert(), bundle)

    def test_new_output_only_and_asset_path_cannot_escape(self):
        bundle = self.convert()
        output = Path(self.temp.name) / 'output'
        write_bundle(bundle, output)
        before = (output / 'models_3d.json').read_bytes()
        with self.assertRaises(FileExistsError):
            write_bundle(bundle, output)
        self.assertEqual((output / 'models_3d.json').read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'content digest'):
            write_bundle(AssetBundle({}, {'../escape': b'bad'}), Path(self.temp.name) / 'unsafe')
        self.assertFalse((Path(self.temp.name) / 'unsafe').exists())

    def test_cli_runs_the_installed_package(self):
        output = Path(self.temp.name) / 'cli'
        result = subprocess.run([sys.executable, '-m', 'atp_glb.export', '--rk', str(self.folder / 'flag.rk'),
                                 '--anim', str(self.folder / 'flag.anim'), '--csv', str(self.folder / 'flag.csv'),
                                 '--identity', 'Synthetic_Flag', '--mesh', 'flag', '--animation', 'wave',
                                 '--rest-name', 'rest', '--events', str(self.folder / 'flag.xml'), '--output', str(output)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((output / 'models_3d.json').read_text()), self.convert().catalogue)

    def test_face_section_overrun_rejected_before_luna(self):
        path = self.folder / 'flag.rk'
        raw = bytearray(path.read_bytes())
        submesh_offset = struct.unpack_from('<I', raw, 84)[0]
        struct.pack_into('<I', raw, submesh_offset, 5)
        path.write_bytes(raw)
        with self.assertRaisesRegex(NativeInputError, 'face range'):
            self.load()

    def test_corrupt_pvr_has_an_explicit_native_diagnostic(self):
        rkm = self.folder / 'flag.rkm'
        rkm.write_text(rkm.read_text().replace('NoCompress=true', 'NoCompress=false'))
        for payload in (b'NOPE' + bytes(48), b'PVR\x03'):
            (self.folder / 'flag.pvr').write_bytes(payload)
            with self.subTest(payload=payload[:4]), self.assertRaisesRegex(NativeInputError, 'Native PVR parse failed'):
                self.load()

    def test_animation_with_a_different_bone_layout_is_rejected(self):
        path = self.folder / 'flag.anim'
        raw = bytearray(path.read_bytes())
        struct.pack_into('<I', raw, 80, 1)
        # Keep the source syntactically valid but with one joint instead of two.
        path.write_bytes(raw[:92] + b''.join(raw[92 + frame * 64:92 + frame * 64 + 32] for frame in range(46)))
        with self.assertRaisesRegex(NativeInputError, 'bone counts differ'):
            self.load()

    def test_material_and_event_extensions_are_not_silently_ignored(self):
        rkm = self.folder / 'flag.rkm'
        rkm.write_text(rkm.read_text().replace('rkshader', 'rkponyhair0'))
        with self.assertRaisesRegex(NativeInputError, 'Unsupported native shader'):
            self.load()
        write_fixture(self.folder)
        for xml in ('<AnimationList><Animation Name="wave"><Frame Index="1"><FutureEffect/></Frame></Animation></AnimationList>',
                    '<AnimationList><FutureAnimation Name="wave"/></AnimationList>',
                    '<AnimationList><Animation Name="wave" FutureController="1"/></AnimationList>'):
            (self.folder / 'flag.xml').write_text(xml)
            with self.subTest(xml=xml), self.assertRaisesRegex(NativeInputError, 'unsupported|Unsupported'):
                self.load()

    def test_animation_source_digest_does_not_depend_on_filename_case(self):
        original = self.convert()
        path = self.folder / 'FLAG.ANIM'
        (self.folder / 'flag.anim').rename(path)
        renamed = convert_native(self.folder / 'flag.rk', path, self.folder / 'flag.csv', ['wave'],
                                 identity='Synthetic_Flag', visible_meshes=['flag'], rest_name='rest',
                                 event_path=self.folder / 'flag.xml')
        self.assertEqual(original, renamed)

    def test_missing_explicit_source_digest_has_a_conversion_diagnostic(self):
        from atp_glb import ConversionError
        native = self.load()
        del native['provenance']['animation_sha256']
        with self.assertRaisesRegex(ConversionError, 'native animation digest'):
            from_native(native, identity='Synthetic_Flag')

    def test_source_hash_not_bone_count_is_the_binding_key(self):
        first = self.convert().catalogue['models']['Synthetic_Flag']['rigKey']
        path = self.folder / 'flag.anim'
        raw = bytearray(path.read_bytes())
        struct.pack_into('<f', raw, 92 + 64 + 16, .2)
        path.write_bytes(raw)
        second = self.convert().catalogue['models']['Synthetic_Flag']['rigKey']
        self.assertNotEqual(first, second)


if __name__ == '__main__':
    unittest.main()
