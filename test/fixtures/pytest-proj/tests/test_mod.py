from pkg.mod import add, neg


class TestMod:
    def test_add(self):
        assert add(1, 2) == 3

    def test_neg(self):
        assert neg(1) == -1
