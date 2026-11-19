//! FNV-1a with 128 bits, written out so a key is the same on every build and every machine.

const OFFSET: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;

const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fnv128 {
    state: u128,
}

impl Default for Fnv128 {
    fn default() -> Fnv128 {
        Fnv128::new()
    }
}

impl Fnv128 {
    pub fn new() -> Fnv128 {
        Fnv128 { state: OFFSET }
    }

    pub fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.state ^= u128::from(*byte);
            self.state = self.state.wrapping_mul(PRIME);
        }
    }

    /// The length goes first, so two fields can never run into each other.
    pub fn field(&mut self, text: &str) {
        self.bytes(&(text.len() as u64).to_le_bytes());
        self.bytes(text.as_bytes());
    }

    pub fn hex(&self) -> String {
        format!("{:032x}", self.state)
    }
}

pub fn fnv128_hex(bytes: &[u8]) -> String {
    let mut hash = Fnv128::new();
    hash.bytes(bytes);
    hash.hex()
}
