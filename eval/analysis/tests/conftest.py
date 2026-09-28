import sys
from pathlib import Path

# 让测试直接导入 eval/analysis 下的包
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
