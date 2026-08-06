import json
import re
import os

# ============================================================
# 設定區
# ============================================================
# 1. 要讀取的 JSON 檔案清單
FILE_LIST = [
    "products.json"
]
# 2. 【核心需求】要統一自動補上的 Brand Value（可依需求修改此字串）
DEFAULT_BRAND_CODE = "dorfketal"

# 3. 定義系統體系識別規則
SYSTEM_RULES = [
    {
        "key": "waterborne",
        "type_zh": "水性",
        "type_en": "Water based",
        "keywords_zh": ["水性", "水基"],
        "keywords_en": [r"\bwater\s*based\b", r"\bwaterborne\b", r"\baqueous\b"]
    },
    {
        "key": "solvent_borne",
        "type_zh": "溶劑型",
        "type_en": "Solvent based",
        "keywords_zh": ["溶劑型", "溶劑"],
        "keywords_en": [r"\bsolvent\s*based\b", r"\bsolvent\s*borne\b", r"\bnon-aqueous\b"]
    },
    {
        "key": "energy curable coatings and inks",
        "type_zh": "能量固化體系",
        "type_en": "Energy curable",
        "keywords_zh": ["能量固化", "光固化", "uv", "紫外線"],
        "keywords_en": [r"\benergy\s*curable\b", r"\buv\b", r"\bradiation\s*curable\b"]
    },
    {
        "key": "powder_coating",
        "type_zh": "粉末塗料",
        "type_en": "Powder coatings",
        "keywords_zh": ["粉末塗料", "粉末"],
        "keywords_en": [r"\bpowder\s*coating\b", r"\bpowder\s*coatings\b", r"\blow\s*bake\s*powder\b"]
    }
]

# 4. 定義模板結構
template = {
    # 1. 全局基礎資訊
    "product_name": "",
    "brand_code": "",
    "featured_categories": [],
    "website": "",
    "tech_data_url": "",
    "composition_zh": "",
    "composition_en": "",
    "chemical_component": "",
    "production_method": "",
    "non_impact_printing_requirements": None,
    # 2. 應用與系統體系
    "recommended_system_type_zh": "",
    "recommended_system_type_en": "",
    "application_fields_zh": "",
    "application_fields_en": "",
    "suggested_use_level_zh": "",
    "suggested_use_level_en": "",
    "examples": "",
    "system": {
        "solvent_borne": 0,
        "waterborne": 0,
        "energy curable coatings and inks": 0,
        "powder_coating": 0
    },
    "applications": {
        "automotive_coatings": None,
        "electro_deposition_coatings": None,
        "general_industrial_coating": None,
        "metallics": None,
        "decorative_coating": None,
        "wet_pu_coloring": None,
        "antistatic_and_conductive_coating": None,
        "industrial coating": None,
        "coil_coating": None,
        "can_coating": None,
        "screw_coating": None,
        "container_coating": None,
        "sheetfed_letterpress": None,
        "heatset": None,
        "coldset": None,
        "publication_gravure_inks": None,
        "liquid_inks_solvent_based": None,
        "liquid_inks_water_based": None,
        "screen_inks": None,
        "uv_curing_inks": None,
        "uv_curing_inkjet_inks": None,
        "aquous_inkjet_inks": None,
        "non-aquous_inkjet_inks": None,
        "toner": None
    },
    # 3. 通用物理與化學數值
    "typical_properties": {
        "melt_point_c": "",
        "mean_particle_size_um": "",
        "max_particle_size_um": "",
        "density_g_cc_25c": "",
        "blackness_my": None,
        "tinting_strength": None,
        "volatile_matter_950c": None,
        "oil_absorption_number": None,
        "ph_value": None,
        "ash_content": None,
        "bet_surface_area": None,
        "average_primary_particle_size_nm": None
    },
    # 4. 性能評級字典
    "performance_ratings": {},
    # 5. 各品牌特色補充說明
    "properties": "",
    "performance_descriptions_zh": {},
    "performance_descriptions_en": {}
}


def clean_value(val):
    """清洗 N/A 或 None 值，轉為字串"""
    if val is None or val == "N/A":
        return ""
    return str(val).strip()


def parse_and_sync_system_type(item):
    """
    解耦判斷 recommended_system_type 並同步填入 system 字典
    """
    rec_zh = clean_value(item.get("recommended_system_type_zh"))
    rec_en = clean_value(item.get("recommended_system_type_en"))

    text_zh = f"{item.get('application_fields_zh', '')} {json.dumps(item.get('performance_descriptions_zh', {}), ensure_ascii=False)}".lower()
    text_en = f"{item.get('application_fields_en', '')} {json.dumps(item.get('performance_descriptions_en', {}))}".lower()

    # 1. 中文缺漏時，單獨進行推導
    if not rec_zh:
        matched_zh = [
            rule["type_zh"] for rule in SYSTEM_RULES
            if any(kw in text_zh for kw in rule["keywords_zh"])
        ]
        if matched_zh:
            rec_zh = "、".join(matched_zh) + "塗料。"

    # 2. 英文缺漏時，單獨進行推導
    if not rec_en:
        matched_en = [
            rule["type_en"] for rule in SYSTEM_RULES
            if any(re.search(kw, text_en) for kw in rule["keywords_en"])
        ]
        if matched_en:
            rec_en = ", ".join(matched_en) + " coatings."

    # 3. 設置 system 字典 (預設 0)
    system_dict = {rule["key"]: 0 for rule in SYSTEM_RULES}

    # 繼承原始 system 字典數值
    raw_sys = item.get("system", {})
    if isinstance(raw_sys, dict):
        for k, v in raw_sys.items():
            if k in system_dict and v is not None:
                system_dict[k] = 1 if str(v).lower() in ["1", "true"] else 0

    # 依據 recommended_system_type 最終文本做補充標記 (正向觸發設為 1)
    combined_text = f"{rec_zh} {rec_en}".lower()
    for rule in SYSTEM_RULES:
        sys_key = rule["key"]
        zh_has = any(kw in combined_text for kw in rule["keywords_zh"])
        en_has = any(re.search(kw, combined_text) for kw in rule["keywords_en"])
        if zh_has or en_has:
            system_dict[sys_key] = 1

    return rec_zh, rec_en, system_dict


def transform_product(item):
    # 深拷貝模板
    res = json.loads(json.dumps(template))

    # 1. 基本欄位映射
    res["product_name"] = clean_value(item.get("product_name"))
    raw_brand = clean_value(item.get("brand_code"))
    res["brand_code"] = raw_brand if raw_brand else DEFAULT_BRAND_CODE

    res["featured_categories"] = item.get("featured_categories", [])
    res["website"] = clean_value(item.get("website"))
    res["tech_data_url"] = clean_value(item.get("tech_data_url"))

    # 【修復】化學成分與成分中文/英文
    res["composition_zh"] = clean_value(item.get("composition_zh") or item.get("chemical_component"))
    res["composition_en"] = clean_value(item.get("composition_en"))
    res["chemical_component"] = clean_value(item.get("chemical_component") or item.get("composition_zh"))

    # 【核心修復】明確把 properties 填進去！
    res["properties"] = clean_value(item.get("properties"))

    res["application_fields_zh"] = clean_value(item.get("application_fields_zh"))
    res["application_fields_en"] = clean_value(item.get("application_fields_en"))
    res["suggested_use_level_zh"] = clean_value(item.get("suggested_use_level_zh"))
    res["suggested_use_level_en"] = clean_value(item.get("suggested_use_level_en"))
    res["non_impact_printing_requirements"] = clean_value(item.get("non_impact_printing_requirements"))
    res["examples"] = clean_value(item.get("examples"))

    # 2. 自動辨認 recommended_system_type 並同步 system 字典
    rec_zh, rec_en, sys_dict = parse_and_sync_system_type(item)
    res["recommended_system_type_zh"] = rec_zh
    res["recommended_system_type_en"] = rec_en
    res["system"] = sys_dict

    # 3. typical_properties 欄位對齊
    tp = item.get("typical_properties", item)
    prop_mapping = {
        "volatile_matter_at_950℃": "volatile_matter_950c",
        "average_primary_particle_size": "average_primary_particle_size_nm"
    }

    for src_key, target_key in prop_mapping.items():
        if src_key in tp and tp[src_key] != "N/A" and tp[src_key] is not None:
            res["typical_properties"][target_key] = clean_value(tp[src_key])

    for prop_key in res["typical_properties"].keys():
        if prop_key in tp and tp[prop_key] != "N/A" and tp[prop_key] is not None:
            res["typical_properties"][prop_key] = clean_value(tp[prop_key])

    # 4. 效能評級與描述字典
    res["performance_ratings"] = item.get("performance_ratings", {})
    res["performance_descriptions_zh"] = item.get("performance_descriptions_zh", {})
    res["performance_descriptions_en"] = item.get("performance_descriptions_en", {})

    # 5. 應用領域映射
    apps = item.get("applications", {})
    app_mapping = {
        "industrial coating": "industrial coating",
        "coil_coating": "coil_coating",
        "can coating": "can_coating",
        "screw coating": "screw_coating",
        "container coating": "container_coating"
    }
    for k, v in apps.items():
        mapped_key = app_mapping.get(k, k)
        if mapped_key in res["applications"]:
            if v is not None and v != "N/A":
                res["applications"][mapped_key] = 1 if str(v) in ["1", "True", "true"] else 0

    return res


# ============================================================
# 主程式執行入口
# ============================================================
if __name__ == "__main__":
    for file_path in FILE_LIST:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                raw_data = json.load(f)
                transformed = [transform_product(item) for item in raw_data]

            base_name, ext = os.path.splitext(file_path)
            output_file = f"{base_name}{ext}"

            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(transformed, f, ensure_ascii=False, indent=2)

            print(f"成功處理: {file_path} (共 {len(transformed)} 筆) -> 已輸出至 {output_file}")

        except FileNotFoundError:
            print(f"提示：找不到檔案 {file_path}，已跳過")
        except json.JSONDecodeError:
            print(f"錯誤：檔案 {file_path} 格式非合法 JSON")