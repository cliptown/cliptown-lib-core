#[allow(dead_code)]
#[path = "../src/embedding_contract.rs"]
mod embedding_contract;

use embedding_contract::{
    model_dimensions, EmbeddingContractError, EmbeddingProvider, PaddedEmbedding,
    EMBEDDING_STORAGE_DIMENSIONS, MAXIMUM_SOURCE_DIMENSIONS,
};

fn signal(dimensions: usize) -> Vec<f32> {
    let mut values = vec![0.0; dimensions];
    values[dimensions - 1] = 1.0;
    values
}

#[test]
fn every_supported_model_boundary_fits_canonical_storage() {
    let cases = [
        (EmbeddingProvider::OpenAi, "text-embedding-ada-002", 1536),
        (EmbeddingProvider::OpenAi, "text-embedding-3-small", 1),
        (EmbeddingProvider::OpenAi, "text-embedding-3-small", 1536),
        (EmbeddingProvider::OpenAi, "text-embedding-3-large", 1),
        (EmbeddingProvider::OpenAi, "text-embedding-3-large", 3072),
        (EmbeddingProvider::Google, "gemini-embedding-001", 128),
        (EmbeddingProvider::Google, "gemini-embedding-001", 3072),
        (EmbeddingProvider::Qwen, "Qwen/Qwen3-Embedding-8B", 32),
        (EmbeddingProvider::Qwen, "Qwen/Qwen3-Embedding-8B", 4096),
        (EmbeddingProvider::Nvidia, "nvidia/NV-Embed-v2", 4096),
        (EmbeddingProvider::Baai, "BAAI/bge-en-icl", 4096),
        (EmbeddingProvider::Voyage, "voyage-4-large", 256),
        (EmbeddingProvider::Voyage, "voyage-4", 512),
        (EmbeddingProvider::Voyage, "voyage-4-lite", 2048),
        (EmbeddingProvider::Custom, "future-model", 4096),
    ];

    for (provider, model, dimensions) in cases {
        let embedding = PaddedEmbedding::from_model_output(provider, model, signal(dimensions))
            .unwrap_or_else(|error| panic!("{provider:?}/{model}/{dimensions}: {error}"));
        assert_eq!(embedding.original_dimensions(), dimensions);
        assert_eq!(embedding.storage_dimensions(), EMBEDDING_STORAGE_DIMENSIONS);
        assert_eq!(embedding.values()[dimensions - 1], 1.0);
        assert!(embedding.values()[dimensions..]
            .iter()
            .all(|value| *value == 0.0));
    }
}

#[test]
fn rejects_values_immediately_outside_provider_boundaries() {
    let cases = [
        (EmbeddingProvider::OpenAi, "text-embedding-ada-002", 1535),
        (EmbeddingProvider::OpenAi, "text-embedding-3-small", 1537),
        (EmbeddingProvider::OpenAi, "text-embedding-3-large", 3073),
        (EmbeddingProvider::Google, "gemini-embedding-001", 127),
        (EmbeddingProvider::Qwen, "Qwen/Qwen3-Embedding-8B", 31),
        (EmbeddingProvider::Nvidia, "nvidia/NV-Embed-v2", 4095),
        (EmbeddingProvider::Baai, "BAAI/bge-en-icl", 4095),
        (EmbeddingProvider::Voyage, "voyage-4", 255),
        (EmbeddingProvider::Voyage, "voyage-4", 257),
        (EmbeddingProvider::Voyage, "voyage-4", 2049),
        (EmbeddingProvider::Custom, "future-model", 4097),
    ];

    for (provider, model, dimensions) in cases {
        assert!(
            PaddedEmbedding::from_model_output(provider, model, signal(dimensions)).is_err(),
            "unexpectedly accepted {provider:?}/{model}/{dimensions}",
        );
    }
}

#[test]
fn rejects_empty_zero_nan_and_infinite_vectors() {
    assert!(matches!(
        PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "text-embedding-3-small",
            Vec::new(),
        ),
        Err(EmbeddingContractError::InvalidDimensions { actual: 0, .. })
    ));
    assert_eq!(
        PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "text-embedding-3-small",
            vec![0.0],
        ),
        Err(EmbeddingContractError::ZeroVector)
    );
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(
            PaddedEmbedding::from_model_output(
                EmbeddingProvider::OpenAi,
                "text-embedding-3-small",
                vec![value],
            ),
            Err(EmbeddingContractError::NonFiniteValue)
        );
    }
}

#[test]
fn padding_preserves_prefix_order_sign_and_norm() {
    let embedding = PaddedEmbedding::from_model_output(
        EmbeddingProvider::OpenAi,
        "text-embedding-3-small",
        vec![3.0, -4.0],
    )
    .expect("two-dimensional MRL output");
    assert_eq!(&embedding.values()[..2], &[3.0, -4.0]);
    assert!(embedding.values()[2..].iter().all(|value| *value == 0.0));
    assert_eq!(embedding.l2_norm(), 5.0);
}

#[test]
fn model_profiles_are_monotonic_and_never_exceed_source_capacity() {
    let models = [
        (EmbeddingProvider::OpenAi, "text-embedding-ada-002"),
        (EmbeddingProvider::OpenAi, "text-embedding-3-small"),
        (EmbeddingProvider::OpenAi, "text-embedding-3-large"),
        (EmbeddingProvider::Google, "gemini-embedding-001"),
        (EmbeddingProvider::Qwen, "Qwen/Qwen3-Embedding-8B"),
        (EmbeddingProvider::Nvidia, "nvidia/NV-Embed-v2"),
        (EmbeddingProvider::Baai, "BAAI/bge-en-icl"),
        (EmbeddingProvider::Voyage, "voyage-4-large"),
        (EmbeddingProvider::Custom, "future-model"),
    ];
    for (provider, model) in models {
        let profile = model_dimensions(provider, model).expect("registered model");
        assert!(profile.minimum <= profile.default);
        assert!(profile.default <= profile.maximum);
        assert!(profile.maximum <= MAXIMUM_SOURCE_DIMENSIONS);
        assert!(profile.maximum < EMBEDDING_STORAGE_DIMENSIONS);
    }
}

#[test]
fn provider_model_identity_is_not_interchangeable() {
    assert_eq!(
        PaddedEmbedding::from_model_output(
            EmbeddingProvider::OpenAi,
            "gemini-embedding-001",
            signal(1536),
        ),
        Err(EmbeddingContractError::UnsupportedProviderModel)
    );
    assert_eq!(
        PaddedEmbedding::from_model_output(
            EmbeddingProvider::Google,
            "text-embedding-3-small",
            signal(1536),
        ),
        Err(EmbeddingContractError::UnsupportedProviderModel)
    );
}
