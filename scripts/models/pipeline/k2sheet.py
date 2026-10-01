"""Remove a ground or shadow sheet that TRELLIS reconstructed under an object (korovany-2 batch C cooks).

Studio concepts show a soft contact shadow under the object; TRELLIS can turn it into a thin double-sided horizontal
sheet near the ground. The sheet is deleted before normalization, so it never sets the object's height, footprint or
ground: near-horizontal faces whose every vertex lies inside a declared height band above the lowest vertex, in raw
TRELLIS units (Blender axes after import, +Z up), then whatever is left of the sheet (connected pieces lying wholly
inside the band, such as its rim) and vertices left without faces.
"""
import bmesh


def remove_ground_sheet(body, spec):
    """spec: {"heightAboveLowest": [low, high] raw units, "minNormalZ": 0.95} or None."""
    if not spec:
        return {"applied": False}
    band_low, band_high = spec["heightAboveLowest"]
    min_normal = spec.get("minNormalZ", 0.95)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    lowest = min(vertex.co.z for vertex in bm.verts)

    def inside(vertex):
        return band_low <= vertex.co.z - lowest <= band_high

    faces = [face for face in bm.faces if abs(face.normal.z) >= min_normal and all(inside(vertex) for vertex in face.verts)]
    area = sum(face.calc_area() for face in faces)
    bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    # Pieces of the sheet that were not horizontal (its rim) are left as small islands wholly inside the band.
    seen, rim = set(), []
    for start in bm.faces:
        if start.index in seen:
            continue
        island, stack = [], [start]
        seen.add(start.index)
        while stack:
            face = stack.pop()
            island.append(face)
            for edge in face.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        if all(inside(vertex) for face in island for vertex in face.verts):
            rim.extend(island)
    bmesh.ops.delete(bm, geom=rim, context="FACES_ONLY")
    loose = [vertex for vertex in bm.verts if not vertex.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    return {"applied": True, "faces": len(faces), "rimFaces": len(rim), "rawArea": round(area, 6), "looseVerticesRemoved": len(loose),
            "heightAboveLowest": [band_low, band_high], "minNormalZ": min_normal}
