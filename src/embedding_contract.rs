//! Provider-aware, lossless embedding normalization for encrypted clipboard history and privacy-safe semantic discovery.

use core::fmt;

pub const EMBEDDING_STORAGE_DIMENSIONS: usize = 4100;
pub const MAXIMUM_SOURCE_DIMENSIONS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingProvider {
    OpenAi,
    Google,
    Voyage,
    Qwen,
    Nvidia,
    Baai,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationProvider {
    OpenAi,
    Anthropic,
    Google,
    Qwen,
    Nvidia,
    Baai,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingPurpose {
    ClipSearch,
    ClipDeduplication,
    Discovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingNormalization {
    Provider,
    L2,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelDimensions {
    pub minimum: usize,
    pub default: usize,
    pub maximum: usize,
    pub supports_mrl: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PaddedEmbedding {
    values: Box<[f32]>,
    original_dimensions: usize,
    l2_norm: f32,
}

impl PaddedEmbedding {
    /// Validates provider/model dimensions and appends trailing zeros to 4,100 slots.
    ///
    /// # Errors
    ///
    /// Returns an error when the provider/model pairing is unknown, the source
    /// dimension is unsupported, a value is non-finite, or the vector has no signal.
    pub fn from_model_output(
        provider: EmbeddingProvider,
        model: &str,
        mut values: Vec<f32>,
    ) -> Result<Self, EmbeddingContractError> {
        let dimensions = values.len();
        validate_model_dimensions(provider, model, dimensions)?;
        if values.iter().any(|value| !value.is_finite()) {
            return Err(EmbeddingContractError::NonFiniteValue);
        }
        let squared_norm = values.iter().map(|value| value * value).sum::<f32>();
        if squared_norm <= f32::EPSILON {
            return Err(EmbeddingContractError::ZeroVector);
        }
        values.resize(EMBEDDING_STORAGE_DIMENSIONS, 0.0);
        Ok(Self {
            values: values.into_boxed_slice(),
            original_dimensions: dimensions,
            l2_norm: squared_norm.sqrt(),
        })
    }

    #[must_use]
    pub fn values(&self) -> &[f32] {
        &self.values
    }

    #[must_use]
    pub const fn original_dimensions(&self) -> usize {
        self.original_dimensions
    }

    #[must_use]
    pub const fn storage_dimensions(&self) -> usize {
        EMBEDDING_STORAGE_DIMENSIONS
    }

    #[must_use]
    pub const fn l2_norm(&self) -> f32 {
        self.l2_norm
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingContractError {
    UnsupportedProviderModel,
    InvalidDimensions {
        actual: usize,
        minimum: usize,
        maximum: usize,
    },
    NonFiniteValue,
    ZeroVector,
}

impl fmt::Display for EmbeddingContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProviderModel => {
                formatter.write_str("embedding provider/model mismatch")
            }
            Self::InvalidDimensions {
                actual,
                minimum,
                maximum,
            } => write!(
                formatter,
                "embedding has {actual} dimensions; expected {minimum}..={maximum}",
            ),
            Self::NonFiniteValue => formatter.write_str("embedding contains a non-finite value"),
            Self::ZeroVector => formatter.write_str("embedding must contain semantic signal"),
        }
    }
}

impl std::error::Error for EmbeddingContractError {}

#[must_use]
pub fn model_dimensions(provider: EmbeddingProvider, model: &str) -> Option<ModelDimensions> {
    let dimensions = match (provider, model) {
        (EmbeddingProvider::OpenAi, "text-embedding-ada-002") => (1536, 1536, 1536, false),
        (EmbeddingProvider::OpenAi, "text-embedding-3-small") => (1, 1536, 1536, true),
        (EmbeddingProvider::OpenAi, "text-embedding-3-large") => (1, 3072, 3072, true),
        (EmbeddingProvider::Google, "gemini-embedding-001") => (128, 3072, 3072, true),
        (EmbeddingProvider::Qwen, "Qwen/Qwen3-Embedding-8B") => (32, 4096, 4096, true),
        (EmbeddingProvider::Nvidia, "nvidia/NV-Embed-v2")
        | (EmbeddingProvider::Baai, "BAAI/bge-en-icl") => (4096, 4096, 4096, false),
        (EmbeddingProvider::Voyage, "voyage-4-large")
        | (EmbeddingProvider::Voyage, "voyage-4")
        | (EmbeddingProvider::Voyage, "voyage-4-lite") => (256, 1024, 2048, true),
        (EmbeddingProvider::Custom, _) => (1, 1536, 4096, false),
        _ => return None,
    };
    Some(ModelDimensions {
        minimum: dimensions.0,
        default: dimensions.1,
        maximum: dimensions.2,
        supports_mrl: dimensions.3,
    })
}

fn validate_model_dimensions(
    provider: EmbeddingProvider,
    model: &str,
    actual: usize,
) -> Result<(), EmbeddingContractError> {
    let expected = model_dimensions(provider, model)
        .ok_or(EmbeddingContractError::UnsupportedProviderModel)?;
    let discrete_voyage_dimension =
        provider == EmbeddingProvider::Voyage && !matches!(actual, 256 | 512 | 1024 | 2048);
    if actual < expected.minimum || actual > expected.maximum || discrete_voyage_dimension {
        return Err(EmbeddingContractError::InvalidDimensions {
            actual,
            minimum: expected.minimum,
            maximum: expected.maximum,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(dimensions: usize) -> Vec<f32> {
        let mut values = vec![0.0; dimensions];
        values[0] = 1.0;
        values
    }

    #[test]
    fn pads_openai_1536_output_with_trailing_zeros() {
        let embedding = PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "text-embedding-3-small",
            signal(1536),
        )
        .expect("valid OpenAI output");
        assert_eq!(embedding.values().len(), 4100);
        assert!(embedding.values()[1536..]
            .iter()
            .all(|value| value.abs() <= f32::EPSILON));
    }

    #[test]
    fn pads_4096_output_with_exactly_four_zeros() {
        let embedding = PaddedEmbedding::from_model_output(
            EmbeddingProvider::Qwen,
            "Qwen/Qwen3-Embedding-8B",
            signal(4096),
        )
        .expect("valid Qwen output");
        assert_eq!(embedding.values().len(), 4100);
        assert!(embedding.values()[4096..]
            .iter()
            .all(|value| value.abs() <= f32::EPSILON));
    }

    #[test]
    fn models_openai_large_default_as_3072_and_allows_shortening() {
        let profile = model_dimensions(EmbeddingProvider::OpenAi, "text-embedding-3-large")
            .expect("known model");
        assert_eq!(profile.default, 3072);
        assert!(PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "text-embedding-3-large",
            signal(1536),
        )
        .is_ok());
    }

    #[test]
    fn rejects_oversized_and_misattributed_vectors() {
        assert!(PaddedEmbedding::from_model_output(
            EmbeddingProvider::Custom,
            "future-model",
            signal(4097),
        )
        .is_err());
        assert!(PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "gemini-embedding-001",
            signal(1536),
        )
        .is_err());
    }
}
